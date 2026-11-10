//! One-shot text generation on a throwaway Pi process.
//!
//! Pilo has no Pi RPC for a bare model completion, so callers that need a
//! single rewritten string (session titles, prompt enhancement) start a
//! temporary Pi runtime with their own system prompt, send one `prompt`, keep
//! the last assistant text snapshot and stop the process. `no_session` keeps
//! the call out of every conversation transcript, and `disable_resources`
//! keeps tools, skills and context files out of the request.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::{
    PiloRuntime,
    events::{PiProcessState, RuntimeEvent, RuntimeEventSink},
    pi_workspace, project,
    server_pi::{PiLaunchOptions, ServerPiSession},
};

#[derive(Clone)]
pub(super) struct OneshotEventSink {
    pub(super) sender: mpsc::UnboundedSender<RuntimeEvent>,
}

impl RuntimeEventSink for OneshotEventSink {
    fn send(&self, event: RuntimeEvent) {
        let _ = self.sender.send(event);
    }
}

/// Correlated RPC on a private process; the caller supplies the operation deadline.
pub(super) async fn request(
    session: &ServerPiSession,
    receiver: &mut mpsc::UnboundedReceiver<RuntimeEvent>,
    mut command: Value,
) -> Result<Value, String> {
    let id = format!("pilo-private-{}", command["type"].as_str().unwrap_or("rpc"));
    command["id"] = json!(id);
    session.send_rpc(command).await?;
    loop {
        match receiver.recv().await {
            Some(RuntimeEvent::RpcMessage { message, .. })
                if message.get("id").and_then(Value::as_str) == Some(id.as_str()) =>
            {
                if message.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(message["error"]
                        .as_str()
                        .unwrap_or("Pi private RPC failed")
                        .to_owned());
                }
                return Ok(message["data"].clone());
            }
            Some(RuntimeEvent::RuntimeError { message, .. }) => return Err(message),
            Some(RuntimeEvent::ProcessState {
                state: PiProcessState::Failed | PiProcessState::Stopped,
                ..
            })
            | None => return Err("Pi private process stopped before answering".to_owned()),
            _ => {}
        }
    }
}

/// Run `prompt` on a fresh Pi process and return its assistant text.
///
/// `timeout` is one budget for the whole operation: resolving the project,
/// starting the process, the prompt RPC, generation and stopping the process.
/// Callers that sit behind an outer request deadline (the Remote WebUI Router)
/// must pass a value shorter than that deadline, otherwise the outer layer
/// answers a generic 408 before the real error can be reported.
///
/// The caller owns the system prompt and the result-normalizing rules; this
/// helper only guarantees that the process is always stopped, and that a
/// timeout, an error stop reason or a dead process becomes an `Err`.
pub(crate) async fn generate_text(
    app: &AppHandle,
    runtime: &PiloRuntime,
    project_id: &str,
    mut launch: PiLaunchOptions,
    prompt: String,
    timeout: Duration,
) -> Result<String, String> {
    let selected_model = match (launch.provider.take(), launch.model.take()) {
        (Some(provider), Some(id)) => Some((provider, id)),
        (None, None) => None,
        _ => return Err("provider and model id must be set together".to_owned()),
    };
    let mut session = ServerPiSession::default();
    // `session` stays outside the deadline so that an elapsed budget drops the
    // session and lets `Drop` schedule the cleanup instead of leaking a stream.
    tokio::time::timeout(timeout, async {
        let project = project::ready(app, &runtime.servers, project_id).await?;
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let runtime_project = pi_workspace::resolve_session_project(app, &project)?;
        session
            .spawn(
                Arc::clone(&runtime.servers),
                OneshotEventSink { sender },
                &runtime_project,
                launch,
            )
            .await?;

        let generated = async {
            // CLI model matching may fall back. Resolve exact identity and auth in
            // this project's process before sending any private user text.
            if let Some((provider, id)) = &selected_model {
                let catalog = request(
                    &session,
                    &mut receiver,
                    json!({ "type": "get_available_models" }),
                )
                .await?;
                let available = catalog["models"].as_array().is_some_and(|models| {
                    models.iter().any(|model| {
                        model["provider"].as_str() == Some(provider.as_str())
                            && model["id"].as_str() == Some(id.as_str())
                    })
                });
                if !available {
                    return Err(format!("Model {provider}/{id} is unavailable in this project; check its provider configuration and credentials"));
                }
                let model = request(&session, &mut receiver, json!({
                    "type": "set_model", "provider": provider, "modelId": id,
                })).await?;
                if model["provider"].as_str() != Some(provider.as_str())
                    || model["id"].as_str() != Some(id.as_str())
                {
                    return Err(format!("Pi did not select the requested model {provider}/{id}"));
                }
                request(
                    &session,
                    &mut receiver,
                    json!({ "type": "set_thinking_level", "level": "off" }),
                )
                .await?;
            }
            session
                .send_rpc(json!({ "type": "prompt", "message": prompt }))
                .await?;
            let mut latest_text = String::new();
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
        }
        .await;

        // Cleanup shares the budget: a stop that cannot finish before the
        // deadline is left to `Drop`, never to the caller's outer timeout.
        let _ = session.stop().await;
        generated
    })
    .await
    .map_err(|_| "Pi one-shot generation timed out".to_owned())?
}
