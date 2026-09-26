use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicBool, Ordering},
};

use serde_json::Value;

use crate::runtime::events::{
    PiProcessState, RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope, RuntimeEventSink,
    RuntimeLogStream,
};

use super::InitializationReply;

/// Bridges raw Pi RPC events into runtime envelopes while tracking the session
/// facts the registry exposes: active turn, resolved session path, and the
/// pending control request reply.
#[derive(Clone)]
pub(super) struct ChatEventSink {
    pub(super) events: RuntimeEventBus,
    pub(super) session_key: String,
    pub(super) project_id: String,
    pub(super) control_reply: Arc<StdMutex<Option<InitializationReply>>>,
    pub(super) initialization_stderr: Arc<StdMutex<String>>,
    pub(super) session_path: Arc<StdMutex<Option<String>>>,
    pub(super) active_turn: Arc<AtomicBool>,
    pub(super) closed: Arc<AtomicBool>,
}

impl RuntimeEventSink for ChatEventSink {
    fn send(&self, event: RuntimeEvent) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        match &event {
            RuntimeEvent::RuntimeLog {
                stream: RuntimeLogStream::Stderr,
                message,
                ..
            } => {
                let mut stderr = self
                    .initialization_stderr
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if stderr.len() < 16 * 1024 {
                    stderr.push_str(message);
                    if stderr.len() > 16 * 1024 {
                        stderr.truncate(16 * 1024);
                    }
                }
            }
            RuntimeEvent::UserMessageStart { .. } | RuntimeEvent::AssistantMessageStart { .. } => {
                self.active_turn.store(true, Ordering::Release);
            }
            RuntimeEvent::AssistantMessageEnd { .. }
            | RuntimeEvent::RuntimeError { .. }
            | RuntimeEvent::ProcessState {
                state: PiProcessState::Failed | PiProcessState::Stopped,
                ..
            } => {
                self.active_turn.store(false, Ordering::Release);
            }
            _ => {}
        }
        if let RuntimeEvent::RuntimeError { message, .. } = &event {
            self.fail_pending_initialization(message);
        } else if let RuntimeEvent::ProcessState {
            state: PiProcessState::Failed | PiProcessState::Stopped,
            ..
        } = &event
        {
            self.fail_pending_initialization(
                "Pi process exited before session initialization completed",
            );
        }
        if let RuntimeEvent::RpcMessage { message, .. } = &event {
            let response_id = message.get("id").and_then(Value::as_str);
            if message.get("type").and_then(Value::as_str) == Some("response")
                && message.get("command").and_then(Value::as_str) == Some("get_state")
                && message.get("success").and_then(Value::as_bool) == Some(true)
                && response_id != Some("pilo-session-prepare")
                && let Some(path) = message.pointer("/data/sessionFile").and_then(Value::as_str)
            {
                *self
                    .session_path
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(path.to_owned());
            }
            if message.get("type").and_then(Value::as_str) == Some("response")
                && matches!(
                    response_id,
                    Some("pilo-session-prepare") | Some("pilo-session-init")
                )
            {
                if let Some(sender) = self
                    .control_reply
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let result = if message.get("success").and_then(Value::as_bool) == Some(true)
                        && message.pointer("/data/cancelled").and_then(Value::as_bool) != Some(true)
                    {
                        Ok(())
                    } else {
                        Err(message
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Pi session initialization was cancelled")
                            .to_owned())
                    };
                    let _ = sender.send(result);
                }
                return;
            }
        }
        self.events.send(RuntimeEventEnvelope::session(
            self.session_key.clone(),
            self.project_id.clone(),
            event,
        ));
    }
}

impl ChatEventSink {
    fn fail_pending_initialization(&self, fallback: &str) {
        let Some(sender) = self
            .control_reply
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        else {
            return;
        };
        let stderr = self
            .initialization_stderr
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .trim()
            .to_owned();
        let message = if stderr.is_empty() {
            fallback.to_owned()
        } else {
            format!("{fallback}: {stderr}")
        };
        let _ = sender.send(Err(message));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex, atomic::AtomicBool};

    use tokio::sync::oneshot;

    use crate::runtime::events::{RuntimeErrorCode, RuntimeLogStream};

    use super::*;

    #[tokio::test]
    async fn initialization_failure_returns_captured_stderr_without_waiting_for_timeout() {
        let (sender, response) = oneshot::channel();
        let sink = ChatEventSink {
            events: RuntimeEventBus::default(),
            session_key: "session".to_owned(),
            project_id: "project".to_owned(),
            control_reply: Arc::new(StdMutex::new(Some(sender))),
            initialization_stderr: Arc::new(StdMutex::new(String::new())),
            session_path: Arc::new(StdMutex::new(None)),
            active_turn: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
        };

        sink.send(RuntimeEvent::RuntimeLog {
            generation: 1,
            stream: RuntimeLogStream::Stderr,
            message: "Failed to load extension: missing dependency".to_owned(),
        });
        sink.send(RuntimeEvent::RuntimeError {
            generation: 1,
            code: RuntimeErrorCode::ProcessIo,
            message: "Pi RPC exited with code 1".to_owned(),
        });

        let error = response
            .await
            .expect("initialization response should be delivered")
            .expect_err("initialization should fail");
        assert!(error.contains("Pi RPC exited with code 1"));
        assert!(error.contains("Failed to load extension: missing dependency"));
    }
}
