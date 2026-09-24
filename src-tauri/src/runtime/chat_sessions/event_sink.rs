use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicBool, Ordering},
};

use serde_json::Value;

use crate::runtime::events::{
    PiProcessState, RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope, RuntimeEventSink,
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
