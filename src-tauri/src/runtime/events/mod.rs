use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, ipc::Channel};
use tokio::sync::broadcast;

use super::debug_trace::runtime_trace;

mod model;
mod trace;

pub use model::*;
use trace::traceable_runtime_event;

const WEB_EVENT_CHANNEL_CAPACITY: usize = 512;
const WEB_EVENT_REPLAY_CAPACITY: usize = 2048;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedRuntimeEvent {
    pub sequence: u64,
    #[serde(flatten)]
    pub event: RuntimeEventEnvelope,
}

#[derive(Clone)]
pub struct RuntimeEventBus {
    channel: Arc<StdMutex<Option<Channel<RuntimeEventEnvelope>>>>,
    web_sender: broadcast::Sender<SequencedRuntimeEvent>,
    replay: Arc<StdMutex<VecDeque<SequencedRuntimeEvent>>>,
    sequence: Arc<AtomicU64>,
}

impl Default for RuntimeEventBus {
    fn default() -> Self {
        let (web_sender, _) = broadcast::channel(WEB_EVENT_CHANNEL_CAPACITY);
        Self {
            channel: Arc::new(StdMutex::new(None)),
            web_sender,
            replay: Arc::new(StdMutex::new(VecDeque::with_capacity(
                WEB_EVENT_REPLAY_CAPACITY,
            ))),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl RuntimeEventBus {
    pub fn subscribe(&self, channel: Channel<RuntimeEventEnvelope>) {
        *self
            .channel
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(channel);
        runtime_trace("channel.subscribe", None, None, Value::Null);
    }

    pub(crate) fn subscribe_web(&self) -> broadcast::Receiver<SequencedRuntimeEvent> {
        self.web_sender.subscribe()
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
            && replay
                .front()
                .is_some_and(|first| first.sequence > sequence.saturating_add(1))
        {
            return None;
        }
        Some(
            replay
                .iter()
                .filter(|event| event.sequence > sequence)
                .cloned()
                .collect(),
        )
    }

    pub fn send(&self, event: RuntimeEventEnvelope) {
        let trace = traceable_runtime_event(&event.event);
        let session_key = event.session_key.clone();
        let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let sequenced = SequencedRuntimeEvent {
            sequence,
            event: event.clone(),
        };
        {
            let mut replay = self
                .replay
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            replay.push_back(sequenced.clone());
            while replay.len() > WEB_EVENT_REPLAY_CAPACITY {
                replay.pop_front();
            }
        }
        let _ = self.web_sender.send(sequenced);

        let channel = self
            .channel
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(channel) = channel else {
            if let Some((event_type, detail)) = trace {
                runtime_trace(
                    "channel.drop_no_subscriber",
                    session_key.as_deref(),
                    None,
                    json!({ "event": event_type, "eventDetail": detail }),
                );
            }
            return;
        };

        if let Some((event_type, detail)) = trace.as_ref() {
            runtime_trace(
                "channel.send",
                session_key.as_deref(),
                None,
                json!({ "event": event_type, "eventDetail": detail }),
            );
        }
        if let Err(error) = channel.send(event) {
            if let Some((event_type, detail)) = trace {
                runtime_trace(
                    "channel.send_error",
                    session_key.as_deref(),
                    None,
                    json!({
                        "event": event_type,
                        "eventDetail": detail,
                        "error": error.to_string(),
                    }),
                );
            }
            log::error!(
                target: "runtime-events",
                "failed to send Tauri channel event: {error}"
            );
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

    #[test]
    fn runtime_event_has_stable_chat_shape() {
        let event = RuntimeEvent::AssistantMessageEnd {
            generation: 7,
            stop_reason: Some("stop".to_owned()),
            error_message: None,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "assistant_message_end",
                "generation": 7,
                "stopReason": "stop",
                "errorMessage": null
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
                "errorMessage": null
            })
        );
    }
}
