use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub const RUNTIME_EVENT_NAME: &str = "pilo://runtime";

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

pub trait RuntimeEventSink: Clone + Send + Sync + 'static {
    fn send(&self, event: RuntimeEvent);
}

#[derive(Clone)]
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl RuntimeEventSink for TauriEventSink {
    fn send(&self, event: RuntimeEvent) {
        let _ = self.app.emit(RUNTIME_EVENT_NAME, event);
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
