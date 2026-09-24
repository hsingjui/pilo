use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::broadcast;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, ipc::Channel};

use super::debug_trace::runtime_trace;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PiProcessState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLogStream {
    Stderr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum RuntimeErrorCode {
    SpawnFailed,
    ProcessIo,
    RpcDecode,
    RpcFraming,
    RpcResponse,
    ProcessExit,
    ProcessWait,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUiRequestPayload {
    pub id: String,
    pub method: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub options: Vec<String>,
    pub placeholder: Option<String>,
    pub prefill: Option<String>,
    pub timeout: Option<u64>,
    pub notify_type: Option<String>,
    pub status_key: Option<String>,
    pub status_text: Option<String>,
    pub widget_key: Option<String>,
    pub widget_lines: Option<Vec<String>>,
    pub widget_placement: Option<String>,
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    ProcessState {
        generation: u64,
        state: PiProcessState,
    },
    RpcMessage {
        generation: u64,
        message: Value,
    },
    UserMessageStart {
        generation: u64,
        text: String,
    },
    AssistantMessageStart {
        generation: u64,
    },
    AssistantTextDelta {
        generation: u64,
        delta: String,
    },
    AssistantTextSnapshot {
        generation: u64,
        text: String,
    },
    AssistantThinkingStart {
        generation: u64,
    },
    AssistantThinkingDelta {
        generation: u64,
        delta: String,
    },
    AssistantThinkingEnd {
        generation: u64,
    },
    ToolExecutionStart {
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "partialResult")]
        partial_result: Value,
    },
    ToolExecutionEnd {
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Value,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    AssistantMessageEnd {
        generation: u64,
        #[serde(rename = "stopReason")]
        stop_reason: Option<String>,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
    },
    QueueUpdate {
        generation: u64,
        steering: Vec<String>,
        #[serde(rename = "followUp")]
        follow_up: Vec<String>,
    },
    CompactionStart {
        generation: u64,
        reason: String,
    },
    CompactionEnd {
        generation: u64,
        reason: String,
        result: Option<Value>,
        aborted: bool,
        #[serde(rename = "willRetry")]
        will_retry: bool,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
    },
    AutoRetryStart {
        generation: u64,
        attempt: u64,
        #[serde(rename = "maxAttempts")]
        max_attempts: u64,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(rename = "errorMessage")]
        error_message: String,
    },
    AutoRetryEnd {
        generation: u64,
        success: bool,
        attempt: u64,
        #[serde(rename = "finalError")]
        final_error: Option<String>,
    },
    SummarizationRetryScheduled {
        generation: u64,
        attempt: u64,
        #[serde(rename = "maxAttempts")]
        max_attempts: u64,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(rename = "errorMessage")]
        error_message: String,
    },
    SummarizationRetryAttemptStart {
        generation: u64,
        source: String,
        reason: Option<String>,
    },
    SummarizationRetryFinished {
        generation: u64,
    },
    ExtensionUiRequest {
        generation: u64,
        #[serde(flatten)]
        request: Box<ExtensionUiRequestPayload>,
    },
    RuntimeLog {
        generation: u64,
        stream: RuntimeLogStream,
        message: String,
    },
    RuntimeError {
        generation: u64,
        code: RuntimeErrorCode,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(flatten)]
    pub event: RuntimeEvent,
}

impl RuntimeEventEnvelope {
    pub fn global(event: RuntimeEvent) -> Self {
        Self {
            session_key: None,
            project_id: None,
            event,
        }
    }

    pub fn session(session_key: String, project_id: String, event: RuntimeEvent) -> Self {
        Self {
            session_key: Some(session_key),
            project_id: Some(project_id),
            event,
        }
    }
}

fn traceable_runtime_event(event: &RuntimeEvent) -> Option<(&'static str, Value)> {
    match event {
        RuntimeEvent::ProcessState { generation, state } => Some((
            "process_state",
            json!({ "generation": generation, "state": state }),
        )),
        RuntimeEvent::RpcMessage {
            generation,
            message,
        } if message.get("type").and_then(Value::as_str) == Some("response") => Some((
            "rpc_message",
            json!({
                "generation": generation,
                "id": message.get("id"),
                "command": message.get("command"),
                "success": message.get("success"),
            }),
        )),
        RuntimeEvent::UserMessageStart { generation, .. } => {
            Some(("user_message_start", json!({ "generation": generation })))
        }
        RuntimeEvent::AssistantMessageStart { generation } => Some((
            "assistant_message_start",
            json!({ "generation": generation }),
        )),
        RuntimeEvent::AssistantMessageEnd {
            generation,
            stop_reason,
            error_message,
        } => Some((
            "assistant_message_end",
            json!({
                "generation": generation,
                "stopReason": stop_reason,
                "hasError": error_message.as_ref().is_some_and(|value| !value.is_empty()),
            }),
        )),
        RuntimeEvent::ToolExecutionStart {
            generation,
            tool_call_id,
            tool_name,
            ..
        } => Some((
            "tool_execution_start",
            json!({
                "generation": generation,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
            }),
        )),
        RuntimeEvent::ToolExecutionEnd {
            generation,
            tool_call_id,
            tool_name,
            is_error,
            ..
        } => Some((
            "tool_execution_end",
            json!({
                "generation": generation,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "isError": is_error,
            }),
        )),
        RuntimeEvent::QueueUpdate {
            generation,
            steering,
            follow_up,
        } => Some((
            "queue_update",
            json!({
                "generation": generation,
                "steering": steering.len(),
                "followUp": follow_up.len(),
            }),
        )),
        RuntimeEvent::CompactionStart { generation, reason } => Some((
            "compaction_start",
            json!({ "generation": generation, "reason": reason }),
        )),
        RuntimeEvent::CompactionEnd {
            generation,
            reason,
            aborted,
            will_retry,
            ..
        } => Some((
            "compaction_end",
            json!({
                "generation": generation,
                "reason": reason,
                "aborted": aborted,
                "willRetry": will_retry,
            }),
        )),
        RuntimeEvent::AutoRetryStart {
            generation,
            attempt,
            max_attempts,
            ..
        } => Some((
            "auto_retry_start",
            json!({
                "generation": generation,
                "attempt": attempt,
                "maxAttempts": max_attempts,
            }),
        )),
        RuntimeEvent::AutoRetryEnd {
            generation,
            success,
            attempt,
            ..
        } => Some((
            "auto_retry_end",
            json!({
                "generation": generation,
                "success": success,
                "attempt": attempt,
            }),
        )),
        RuntimeEvent::RuntimeError {
            generation,
            code,
            message,
        } => Some((
            "runtime_error",
            json!({
                "generation": generation,
                "code": code,
                "message": message,
            }),
        )),
        _ => None,
    }
}

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
