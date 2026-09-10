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
pub enum RuntimeErrorCode {
    SpawnFailed,
    ProcessIo,
    RpcDecode,
    RpcFraming,
    ProcessExit,
    ProcessWait,
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
    fn runtime_event_has_stable_type_tag() {
        let event = RuntimeEvent::RpcMessage {
            generation: 7,
            message: serde_json::json!({ "type": "response", "success": true }),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "rpc_message",
                "generation": 7,
                "message": { "type": "response", "success": true }
            })
        );
    }
}
