use std::{
    collections::{HashMap, VecDeque},
    io::{self, Write},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, ipc::Channel};
use tokio::sync::{broadcast, watch};

use super::debug_trace::runtime_trace;

mod model;
mod session_reads;
mod trace;

pub use model::*;
use trace::traceable_runtime_event;

const WEB_EVENT_CHANNEL_CAPACITY: usize = 512;
const WEB_EVENT_CHANNEL_MAX_BYTES: usize = 64 * 1024 * 1024;
const WEB_EVENT_REPLAY_CAPACITY: usize = 2048;
const WEB_EVENT_REPLAY_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
struct EventReplay {
    events: VecDeque<(SequencedRuntimeEvent, usize)>,
    bytes: usize,
}

#[derive(Default)]
struct WebEventQueue {
    buffer: EventReplay,
    latest_sequence: u64,
}

pub(crate) struct WebEventReceiver {
    queue: Arc<StdMutex<WebEventQueue>>,
    notifications: watch::Receiver<()>,
    next_sequence: u64,
}

impl WebEventReceiver {
    pub(crate) fn try_recv(
        &mut self,
    ) -> Result<SequencedRuntimeEvent, broadcast::error::TryRecvError> {
        let queue = self
            .queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((first, _)) = queue.buffer.events.front() {
            if self.next_sequence < first.sequence {
                let skipped = first.sequence - self.next_sequence;
                self.next_sequence = first.sequence;
                return Err(broadcast::error::TryRecvError::Lagged(skipped));
            }
            if let Ok(offset) = usize::try_from(self.next_sequence - first.sequence)
                && let Some((event, _)) = queue.buffer.events.get(offset)
            {
                self.next_sequence = event.sequence + 1;
                return Ok(event.clone());
            }
        }
        if self.next_sequence <= queue.latest_sequence {
            let skipped = queue.latest_sequence - self.next_sequence + 1;
            self.next_sequence = queue.latest_sequence + 1;
            return Err(broadcast::error::TryRecvError::Lagged(skipped));
        }
        Err(broadcast::error::TryRecvError::Empty)
    }

    pub(crate) async fn recv(
        &mut self,
    ) -> Result<SequencedRuntimeEvent, broadcast::error::RecvError> {
        loop {
            match self.try_recv() {
                Ok(event) => return Ok(event),
                Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                    return Err(broadcast::error::RecvError::Lagged(skipped));
                }
                Err(broadcast::error::TryRecvError::Closed) => {
                    return Err(broadcast::error::RecvError::Closed);
                }
                Err(broadcast::error::TryRecvError::Empty) => {}
            }
            self.notifications
                .changed()
                .await
                .map_err(|_| broadcast::error::RecvError::Closed)?;
        }
    }
}

#[derive(Default)]
pub(crate) struct PayloadSize(pub(crate) usize);

impl Write for PayloadSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedRuntimeEvent {
    pub sequence: u64,
    #[serde(flatten)]
    pub event: RuntimeEventEnvelope,
}

#[derive(Clone)]
pub struct RuntimeEventBus {
    channels: Arc<StdMutex<HashMap<String, Channel<RuntimeEventEnvelope>>>>,
    web_sender: watch::Sender<()>,
    web_queue: Arc<StdMutex<WebEventQueue>>,
    replay: Arc<StdMutex<EventReplay>>,
    sequence: Arc<AtomicU64>,
    session_read_paths: Arc<StdMutex<Option<super::host_paths::HostPaths>>>,
    external_read_activity: session_reads::ExternalReadActivity,
    session_completions: Arc<StdMutex<session_reads::SessionCompletionQueue>>,
}

impl Default for RuntimeEventBus {
    fn default() -> Self {
        let (web_sender, _) = watch::channel(());
        Self {
            channels: Arc::new(StdMutex::new(HashMap::new())),
            web_sender,
            web_queue: Arc::new(StdMutex::new(WebEventQueue::default())),
            replay: Arc::new(StdMutex::new(EventReplay::default())),
            sequence: Arc::new(AtomicU64::new(0)),
            session_read_paths: Arc::new(StdMutex::new(None)),
            external_read_activity: Arc::new(StdMutex::new(HashMap::new())),
            session_completions: Arc::new(StdMutex::new(
                session_reads::SessionCompletionQueue::default(),
            )),
        }
    }
}

impl RuntimeEventBus {
    pub fn subscribe(&self, window_label: &str, channel: Channel<RuntimeEventEnvelope>) {
        let channel_id = channel.id();
        // Reload replaces only this window's channel; other windows stay subscribed.
        self.channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(window_label.to_owned(), channel);
        runtime_trace(
            "channel.subscribe",
            None,
            None,
            json!({ "windowLabel": window_label, "channelId": channel_id }),
        );
    }

    pub fn unsubscribe(&self, window_label: &str) {
        self.channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(window_label);
        runtime_trace(
            "channel.unsubscribe",
            None,
            None,
            json!({ "windowLabel": window_label }),
        );
    }

    pub(crate) fn subscribe_web(&self) -> WebEventReceiver {
        let _publish_guard = self
            .replay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        WebEventReceiver {
            queue: Arc::clone(&self.web_queue),
            notifications: self.web_sender.subscribe(),
            next_sequence: self.latest_sequence() + 1,
        }
    }

    pub(crate) fn latest_sequence(&self) -> u64 {
        self.sequence.load(Ordering::Acquire)
    }

    pub(crate) fn replay_after(&self, sequence: u64) -> Option<Vec<SequencedRuntimeEvent>> {
        let replay = self
            .replay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if sequence > 0
            && replay.events.front().map_or_else(
                || sequence < self.latest_sequence(),
                |(first, _)| first.sequence > sequence.saturating_add(1),
            )
        {
            return None;
        }
        Some(
            replay
                .events
                .iter()
                .filter(|(event, _)| event.sequence > sequence)
                .map(|(event, _)| event.clone())
                .collect(),
        )
    }

    pub fn send(&self, event: RuntimeEventEnvelope) {
        let trace = traceable_runtime_event(&event.event);
        let session_key = event.session_key.clone();
        let (sequence, payload_bytes) = {
            let mut replay = self
                .replay
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
            let sequenced = SequencedRuntimeEvent {
                sequence,
                event: event.clone(),
            };
            // Count without allocating another serialized copy of large RPC results.
            let mut size = PayloadSize::default();
            let bytes = if serde_json::to_writer(&mut size, &sequenced).is_ok() {
                size.0
            } else {
                usize::MAX
            };
            // Events above the replay limit leave a gap; the live queue has its own limit.
            if bytes > WEB_EVENT_REPLAY_MAX_BYTES {
                replay.events.clear();
                replay.bytes = 0;
            } else {
                while replay.events.len() >= WEB_EVENT_REPLAY_CAPACITY
                    || replay.bytes.saturating_add(bytes) > WEB_EVENT_REPLAY_MAX_BYTES
                {
                    let Some((_, evicted_bytes)) = replay.events.pop_front() else {
                        break;
                    };
                    replay.bytes -= evicted_bytes;
                }
                replay.bytes += bytes;
                replay.events.push_back((sequenced.clone(), bytes));
            }
            // Publish under the same lock so concurrent sessions keep sequence order.
            let mut queue = self
                .web_queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            queue.latest_sequence = sequence;
            if self.web_sender.receiver_count() == 0 || bytes > WEB_EVENT_CHANNEL_MAX_BYTES {
                queue.buffer.events.clear();
                queue.buffer.bytes = 0;
            } else {
                while queue.buffer.events.len() >= WEB_EVENT_CHANNEL_CAPACITY
                    || queue.buffer.bytes.saturating_add(bytes) > WEB_EVENT_CHANNEL_MAX_BYTES
                {
                    let Some((_, evicted_bytes)) = queue.buffer.events.pop_front() else {
                        break;
                    };
                    queue.buffer.bytes -= evicted_bytes;
                }
                queue.buffer.bytes += bytes;
                queue.buffer.events.push_back((sequenced, bytes));
            }
            let _ = self.web_sender.send(());
            (sequence, bytes)
        };

        let channels = self
            .channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if channels.is_empty() {
            if let Some((event_type, detail)) = trace {
                runtime_trace(
                    "channel.drop_no_subscriber",
                    session_key.as_deref(),
                    None,
                    json!({ "event": event_type, "eventDetail": detail }),
                );
            }
            return;
        }

        for (window_label, channel) in channels {
            if let Some((event_type, detail)) = trace.as_ref() {
                runtime_trace(
                    "channel.send",
                    session_key.as_deref(),
                    None,
                    json!({
                        "windowLabel": window_label,
                        "channelId": channel.id(),
                        "sequence": sequence,
                        "payloadBytes": payload_bytes,
                        "event": event_type,
                        "eventDetail": detail,
                    }),
                );
            }
            if let Err(error) = channel.send(event.clone()) {
                if let Some((event_type, detail)) = trace.as_ref() {
                    runtime_trace(
                        "channel.send_error",
                        session_key.as_deref(),
                        None,
                        json!({
                            "windowLabel": window_label,
                            "channelId": channel.id(),
                            "sequence": sequence,
                            "payloadBytes": payload_bytes,
                            "event": event_type,
                            "eventDetail": detail,
                            "error": error.to_string(),
                        }),
                    );
                }
                log::error!(
                    target: "runtime-events",
                    "failed to send Tauri channel event to {window_label}: {error}"
                );
            }
        }
    }
}

pub trait RuntimeEventSink: Clone + Send + Sync + 'static {
    fn send(&self, event: RuntimeEvent);
}

#[derive(Clone)]
pub struct TauriEventSink {
    events: RuntimeEventBus,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self {
            events: app.state::<RuntimeEventBus>().inner().clone(),
        }
    }
}

impl RuntimeEventSink for TauriEventSink {
    fn send(&self, event: RuntimeEvent) {
        self.events.send(RuntimeEventEnvelope::global(event));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::token_usage::TokenUsage;

    #[test]
    fn runtime_event_has_stable_chat_shape() {
        let event = RuntimeEvent::AssistantMessageEnd {
            generation: 7,
            stop_reason: Some("stop".to_owned()),
            error_message: None,
            usage: Some(TokenUsage {
                input: 10,
                output: 5,
                cache_read: 20,
                cache_write: 2,
                total: 37,
                cost: Some(0.01),
            }),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "assistant_message_end",
                "generation": 7,
                "stopReason": "stop",
                "errorMessage": null,
                "usage": {
                    "input": 10,
                    "output": 5,
                    "cacheRead": 20,
                    "cacheWrite": 2,
                    "total": 37,
                    "cost": 0.01
                }
            })
        );
    }

    #[test]
    fn session_envelope_keeps_routing_metadata_and_event_shape() {
        let envelope = RuntimeEventEnvelope::session(
            "chat-1".to_owned(),
            "project-1".to_owned(),
            RuntimeEvent::AssistantTextDelta {
                generation: 4,
                delta: "hello".to_owned(),
            },
        );

        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            serde_json::json!({
                "sessionKey": "chat-1",
                "projectId": "project-1",
                "type": "assistant_text_delta",
                "generation": 4,
                "delta": "hello"
            })
        );
    }

    #[test]
    fn raw_rpc_event_keeps_runtime_foundation_contract() {
        let event = RuntimeEvent::RpcMessage {
            generation: 8,
            message: serde_json::json!({ "type": "queue_update" }),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "rpc_message",
                "generation": 8,
                "message": { "type": "queue_update" }
            })
        );
    }

    #[test]
    fn tool_execution_event_keeps_frontend_field_names() {
        let event = RuntimeEvent::ToolExecutionEnd {
            generation: 9,
            tool_call_id: "call-1".to_owned(),
            tool_name: "bash".to_owned(),
            result: serde_json::json!({ "content": [] }),
            is_error: false,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "tool_execution_end",
                "generation": 9,
                "toolCallId": "call-1",
                "toolName": "bash",
                "result": { "content": [] },
                "isError": false
            })
        );
    }

    #[tokio::test]
    async fn web_subscribers_share_one_ordered_event_stream() {
        let bus = RuntimeEventBus::default();
        let mut first = bus.subscribe_web();
        let mut second = bus.subscribe_web();

        bus.send(RuntimeEventEnvelope::session(
            "chat-1".to_owned(),
            "project-1".to_owned(),
            RuntimeEvent::AssistantTextDelta {
                generation: 1,
                delta: "hello".to_owned(),
            },
        ));

        let first_event = first.recv().await.unwrap();
        let second_event = second.recv().await.unwrap();
        assert_eq!(first_event.sequence, 1);
        assert_eq!(second_event.sequence, 1);
        assert_eq!(first_event.event.session_key.as_deref(), Some("chat-1"));
        assert_eq!(second_event.event.project_id.as_deref(), Some("project-1"));

        let replay = bus.replay_after(0).unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].sequence, 1);
        assert_eq!(bus.latest_sequence(), 1);
    }

    #[test]
    fn replay_reports_a_gap_after_buffer_eviction() {
        let bus = RuntimeEventBus::default();
        // Send one event past the replay window plus one more, so sequences 1 and 2
        // are both evicted and a client that last saw sequence 1 has a real gap.
        for generation in 0..=(WEB_EVENT_REPLAY_CAPACITY as u64 + 1) {
            bus.send(RuntimeEventEnvelope::global(
                RuntimeEvent::AssistantMessageEnd {
                    generation,
                    stop_reason: Some("stop".to_owned()),
                    error_message: None,
                    usage: None,
                },
            ));
        }

        assert!(bus.replay_after(1).is_none());
        let latest = bus.latest_sequence();
        let replay = bus.replay_after(latest.saturating_sub(1)).unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].sequence, latest);
    }

    #[test]
    fn concurrent_publishers_keep_replay_and_broadcast_sequence_order() {
        let bus = RuntimeEventBus::default();
        let mut subscriber = bus.subscribe_web();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let bus = bus.clone();
                scope.spawn(move || {
                    for generation in 0..64 {
                        bus.send(RuntimeEventEnvelope::global(
                            RuntimeEvent::AssistantTextDelta {
                                generation,
                                delta: "x".to_owned(),
                            },
                        ));
                    }
                });
            }
        });
        let replay = bus.replay_after(0).unwrap();
        assert_eq!(replay.len(), 256);
        for (index, event) in replay.iter().enumerate() {
            assert_eq!(event.sequence, index as u64 + 1);
            assert_eq!(subscriber.try_recv().unwrap().sequence, event.sequence);
        }
    }

    #[test]
    fn replay_evicts_large_payloads_by_bytes_before_reaching_event_count_limit() {
        let bus = RuntimeEventBus::default();
        for generation in 0..5 {
            bus.send(RuntimeEventEnvelope::global(
                RuntimeEvent::AssistantTextSnapshot {
                    generation,
                    text: "x".repeat(WEB_EVENT_REPLAY_MAX_BYTES / 4),
                },
            ));
        }
        let replay = bus.replay.lock().unwrap();
        assert!(replay.bytes <= WEB_EVENT_REPLAY_MAX_BYTES);
        assert!(replay.events.len() < 5);
        drop(replay);
        assert!(bus.replay_after(1).is_none());
        assert_eq!(bus.replay_after(4).unwrap()[0].sequence, 5);
    }

    #[tokio::test]
    async fn oversized_event_is_delivered_live_but_requires_replay_resync() {
        let bus = RuntimeEventBus::default();
        bus.send(RuntimeEventEnvelope::global(
            RuntimeEvent::AssistantMessageStart { generation: 1 },
        ));
        let mut subscriber = bus.subscribe_web();
        bus.send(RuntimeEventEnvelope::global(
            RuntimeEvent::AssistantTextSnapshot {
                generation: 1,
                text: "x".repeat(WEB_EVENT_REPLAY_MAX_BYTES + 1),
            },
        ));
        assert_eq!(subscriber.recv().await.unwrap().sequence, 2);
        assert!(bus.replay_after(1).is_none());
        assert!(bus.replay_after(2).unwrap().is_empty());
        let replay = bus.replay.lock().unwrap();
        assert_eq!(replay.bytes, 0);
        assert!(replay.events.is_empty());
    }

    #[test]
    fn sequenced_event_serialization_flattens_routing_and_runtime_fields() {
        let event = SequencedRuntimeEvent {
            sequence: 42,
            event: RuntimeEventEnvelope::session(
                "chat-1".to_owned(),
                "project-1".to_owned(),
                RuntimeEvent::AssistantMessageEnd {
                    generation: 3,
                    stop_reason: Some("stop".to_owned()),
                    error_message: None,
                    usage: None,
                },
            ),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "sequence": 42,
                "sessionKey": "chat-1",
                "projectId": "project-1",
                "type": "assistant_message_end",
                "generation": 3,
                "stopReason": "stop",
                "errorMessage": null,
                "usage": null
            })
        );
    }
}
