//! One-shot text generation on a throwaway Pi process.
//!
//! Pilo has no Pi RPC for a bare model completion, so callers that need a
//! single rewritten string (session titles, prompt enhancement) start a
//! temporary Pi runtime with their own system prompt, send one `prompt`, keep
//! the last assistant text snapshot and stop the process. `no_session` keeps
//! the call out of every conversation transcript, and `disable_resources`
//! keeps tools, skills and context files out of the request.

use std::{sync::Arc, time::Duration};

use serde_json::json;
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::{
    PiloRuntime,
    events::{PiProcessState, RuntimeEvent, RuntimeEventSink},
    pi_workspace, project,
    server_pi::{PiLaunchOptions, ServerPiSession},
};

#[derive(Clone)]
struct OneshotEventSink {
    sender: mpsc::UnboundedSender<RuntimeEvent>,
}

impl RuntimeEventSink for OneshotEventSink {
    fn send(&self, event: RuntimeEvent) {
        let _ = self.sender.send(event);
    }
}

/// Run `prompt` on a fresh Pi process and return its assistant text.
///
/// The caller owns the system prompt and the result-normalizing rules; this
/// helper only guarantees that the process is always stopped, and that a
/// timeout, an error stop reason or a dead process becomes an `Err`.
pub(crate) async fn generate_text(
    app: &AppHandle,
    runtime: &PiloRuntime,
    project_id: &str,
    launch: PiLaunchOptions,
    prompt: String,
    timeout: Duration,
) -> Result<String, String> {
    let project = project::get(app, project_id)?;
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let mut session = ServerPiSession::default();
    let runtime_project = pi_workspace::resolve_session_project(app, &project)?;
    session
        .spawn(
            Arc::clone(&runtime.servers),
            OneshotEventSink { sender },
            &runtime_project,
            launch,
        )
        .await?;

    let result = async {
        session
            .send_rpc(json!({ "type": "prompt", "message": prompt }))
            .await?;
        let mut latest_text = String::new();
        tokio::time::timeout(timeout, async {
            loop {
                let event = receiver
                    .recv()
                    .await
                    .ok_or_else(|| "Pi one-shot event stream closed".to_owned())?;
                match event {
                    RuntimeEvent::AssistantTextSnapshot { text, .. } => latest_text = text,
                    RuntimeEvent::AssistantMessageEnd {
                        stop_reason,
                        error_message,
                        ..
                    } => {
                        if stop_reason.as_deref() == Some("error")
                            || error_message
                                .as_deref()
                                .is_some_and(|value| !value.trim().is_empty())
                        {
                            return Err(error_message
                                .unwrap_or_else(|| "Pi failed to generate text".to_owned()));
                        }
                        return Ok(latest_text);
                    }
                    RuntimeEvent::RuntimeError { message, .. } => return Err(message),
                    RuntimeEvent::ProcessState {
                        state: PiProcessState::Failed | PiProcessState::Stopped,
                        ..
                    } => {
                        return Err("Pi one-shot process stopped before producing text".to_owned());
                    }
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| "Pi one-shot generation timed out".to_owned())?
    }
    .await;

    let _ = session.stop().await;
    result
}
