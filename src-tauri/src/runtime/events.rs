use std::sync::{Arc, Mutex as StdMutex};

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

#[derive(Clone, Default)]
pub struct RuntimeEventBus {
    channel: Arc<StdMutex<Option<Channel<RuntimeEventEnvelope>>>>,
}

impl RuntimeEventBus {
    pub fn subscribe(&self, channel: Channel<RuntimeEventEnvelope>) {
        *self
            .channel
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(channel);
        runtime_trace("channel.subscribe", None, None, Value::Null);
    }

    pub fn send(&self, event: RuntimeEventEnvelope) {
        let trace = traceable_runtime_event(&event.event);
        let session_key = event.session_key.clone();
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
            eprintln!("[runtime-events] failed to send Tauri channel event: {error}");
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
}
