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
    pub(super) compacting: Arc<AtomicBool>,
    pub(super) pending_prompt_id: Arc<StdMutex<Option<String>>>,
    pub(super) closed: Arc<AtomicBool>,
}

impl RuntimeEventSink for ChatEventSink {
    fn send(&self, event: RuntimeEvent) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let completed_turn = matches!(
            &event,
            RuntimeEvent::AssistantMessageEnd { .. }
                | RuntimeEvent::PiReattached { active: false, .. }
        ) && self.active_turn.load(Ordering::Acquire);
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
            RuntimeEvent::UserMessageStart { .. }
            | RuntimeEvent::AssistantMessageStart { .. }
            | RuntimeEvent::AutoRetryStart { .. } => {
                // A live turn now owns the flag, not the pending prompt preflight.
                *self
                    .pending_prompt_id
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                self.active_turn.store(true, Ordering::Release);
            }
            RuntimeEvent::PiReattached { active, .. } => {
                *self
                    .pending_prompt_id
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                self.active_turn.store(*active, Ordering::Release);
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
        match &event {
            RuntimeEvent::PiReattached { compacting, .. } => {
                self.compacting.store(*compacting, Ordering::Release)
            }
            RuntimeEvent::CompactionStart { .. } => self.compacting.store(true, Ordering::Release),
            RuntimeEvent::CompactionEnd { .. }
            | RuntimeEvent::RuntimeError { .. }
            | RuntimeEvent::ProcessState {
                state: PiProcessState::Failed | PiProcessState::Stopped,
                ..
            } => self.compacting.store(false, Ordering::Release),
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
            if message.get("type").and_then(Value::as_str) == Some("response")
                && message.get("command").and_then(Value::as_str) == Some("compact")
            {
                self.compacting.store(false, Ordering::Release);
            }
            let response_id = message.get("id").and_then(Value::as_str);
            if message.get("type").and_then(Value::as_str) == Some("response")
                && message.get("command").and_then(Value::as_str) == Some("prompt")
            {
                let mut pending = self
                    .pending_prompt_id
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if pending.as_deref() == response_id {
                    *pending = None;
                    // A rejected prompt, or one consumed without starting a turn
                    // (`disposition: "handled"`, e.g. an extension command or input
                    // handler), never emits turn events, so the preemptive
                    // active-turn flag must be rolled back here.
                    let rejected = message.get("success").and_then(Value::as_bool) == Some(false);
                    let handled_without_turn =
                        message.pointer("/data/disposition").and_then(Value::as_str)
                            == Some("handled");
                    if rejected || handled_without_turn {
                        self.active_turn.store(false, Ordering::Release);
                    }
                }
            }
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
        if completed_turn {
            let path = self
                .session_path
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if let Some(path) = path {
                self.events
                    .record_session_completion(self.project_id.clone(), path);
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

    #[test]
    fn compaction_completion_does_not_clear_an_active_turn() {
        let sink = ChatEventSink {
            events: RuntimeEventBus::default(),
            session_key: "session".to_owned(),
            project_id: "project".to_owned(),
            control_reply: Arc::new(StdMutex::new(None)),
            initialization_stderr: Arc::new(StdMutex::new(String::new())),
            session_path: Arc::new(StdMutex::new(Some("session.jsonl".to_owned()))),
            active_turn: Arc::new(AtomicBool::new(true)),
            compacting: Arc::new(AtomicBool::new(false)),
            pending_prompt_id: Arc::new(StdMutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
        };
        sink.send(RuntimeEvent::CompactionStart {
            generation: 1,
            reason: "manual".to_owned(),
        });
        assert!(sink.compacting.load(Ordering::Acquire));
        sink.send(RuntimeEvent::CompactionEnd {
            generation: 1,
            reason: "manual".to_owned(),
            result: None,
            aborted: false,
            will_retry: false,
            error_message: None,
        });
        assert!(!sink.compacting.load(Ordering::Acquire));
        assert!(sink.active_turn.load(Ordering::Acquire));
        sink.compacting.store(true, Ordering::Release);
        sink.send(RuntimeEvent::RpcMessage {
            generation: 1,
            message: serde_json::json!({
                "type": "response", "command": "compact", "success": false,
            }),
        });
        assert!(!sink.compacting.load(Ordering::Acquire));
        assert!(sink.active_turn.load(Ordering::Acquire));
    }

    #[test]
    fn rejected_prompt_rolls_back_only_the_prompt_that_set_active_turn() {
        let sink = ChatEventSink {
            events: RuntimeEventBus::default(),
            session_key: "session".to_owned(),
            project_id: "project".to_owned(),
            control_reply: Arc::new(StdMutex::new(None)),
            initialization_stderr: Arc::new(StdMutex::new(String::new())),
            session_path: Arc::new(StdMutex::new(Some("session.jsonl".to_owned()))),
            active_turn: Arc::new(AtomicBool::new(true)),
            compacting: Arc::new(AtomicBool::new(false)),
            pending_prompt_id: Arc::new(StdMutex::new(Some("pilo-prompt-1".to_owned()))),
            closed: Arc::new(AtomicBool::new(false)),
        };
        // A rejection for another prompt must not clear a running turn.
        sink.send(RuntimeEvent::RpcMessage {
            generation: 1,
            message: serde_json::json!({
                "type": "response", "command": "prompt", "id": "other", "success": false,
            }),
        });
        assert!(sink.active_turn.load(Ordering::Acquire));
        assert!(sink.pending_prompt_id.lock().unwrap().is_some());
        // The owning prompt's rejection rolls the preemptive flag back.
        sink.send(RuntimeEvent::RpcMessage {
            generation: 1,
            message: serde_json::json!({
                "type": "response", "command": "prompt", "id": "pilo-prompt-1", "success": false,
            }),
        });
        assert!(!sink.active_turn.load(Ordering::Acquire));
        assert!(sink.pending_prompt_id.lock().unwrap().is_none());
        // A success response releases ownership but keeps the turn active.
        sink.active_turn.store(true, Ordering::Release);
        *sink.pending_prompt_id.lock().unwrap() = Some("pilo-prompt-2".to_owned());
        sink.send(RuntimeEvent::RpcMessage {
            generation: 1,
            message: serde_json::json!({
                "type": "response", "command": "prompt", "id": "pilo-prompt-2", "success": true,
                "data": { "disposition": "started" },
            }),
        });
        assert!(sink.active_turn.load(Ordering::Acquire));
        assert!(sink.pending_prompt_id.lock().unwrap().is_none());
        // A prompt consumed without starting a turn releases the preemptive flag.
        sink.active_turn.store(true, Ordering::Release);
        *sink.pending_prompt_id.lock().unwrap() = Some("pilo-prompt-3".to_owned());
        sink.send(RuntimeEvent::RpcMessage {
            generation: 1,
            message: serde_json::json!({
                "type": "response", "command": "prompt", "id": "pilo-prompt-3", "success": true,
                "data": { "disposition": "handled" },
            }),
        });
        assert!(!sink.active_turn.load(Ordering::Acquire));
        assert!(sink.pending_prompt_id.lock().unwrap().is_none());
    }

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
            compacting: Arc::new(AtomicBool::new(false)),
            pending_prompt_id: Arc::new(StdMutex::new(None)),
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
