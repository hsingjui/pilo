use std::{sync::Arc, time::Duration};

use tauri::{AppHandle, State};
use tokio::sync::mpsc;

use crate::runtime::{
    PiloRuntime,
    events::{PiProcessState, RuntimeEvent, RuntimeEventSink},
    pi_workspace, project,
    server_pi::{PiLaunchOptions, ServerPiSession},
    storage,
};

const SESSION_NAMING_SYSTEM_PROMPT: &str = "Generate a concise title for a coding conversation from the user's first message. Return exactly one plain-text title with no quotes, markdown, explanation, prefix, or suffix. Use the same language as the user. Prefer at most 24 CJK characters or 60 Latin characters.";

#[derive(Clone)]
struct SessionNamingEventSink {
    sender: mpsc::UnboundedSender<RuntimeEvent>,
}

impl RuntimeEventSink for SessionNamingEventSink {
    fn send(&self, event: RuntimeEvent) {
        let _ = self.sender.send(event);
    }
}

fn normalize_generated_session_title(value: &str) -> Option<String> {
    let line = value.lines().map(str::trim).find(|line| !line.is_empty())?;
    let trimmed = line
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '\x60' | '*' | '#'))
        .trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut title = trimmed.chars().take(80).collect::<String>();
    if trimmed.chars().count() > 80 {
        title.push('…');
    }
    Some(title)
}

pub async fn generate_session_title(
    app: &AppHandle,
    runtime: &PiloRuntime,
    project_id: &str,
    message: &str,
) -> Result<Option<String>, String> {
    let message = message.trim();
    if message.is_empty() {
        return Ok(None);
    }

    let project = project::get(app, project_id)?;
    let naming_model =
        storage::get_connection_naming_model(&storage::open(app)?, &project.connection.id)?;
    let Some(naming_model) = naming_model else {
        return Ok(None);
    };

    let (sender, mut receiver) = mpsc::unbounded_channel();
    let mut session = ServerPiSession::default();
    let runtime_project = pi_workspace::resolve_session_project(app, &project)?;
    session
        .spawn(
            Arc::clone(&runtime.servers),
            SessionNamingEventSink { sender },
            &runtime_project,
            PiLaunchOptions {
                no_session: true,
                disable_resources: true,
                provider: Some(naming_model.provider),
                model: Some(naming_model.model_id),
                thinking: Some("off".to_owned()),
                system_prompt: Some(SESSION_NAMING_SYSTEM_PROMPT.to_owned()),
                ..PiLaunchOptions::default()
            },
        )
        .await?;

    let result = async {
        session
            .send_rpc(serde_json::json!({ "type": "prompt", "message": message }))
            .await?;
        let mut latest_text = String::new();
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let event = receiver
                    .recv()
                    .await
                    .ok_or_else(|| "Pi naming event stream closed".to_owned())?;
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
                            return Err(error_message.unwrap_or_else(|| {
                                "Pi failed to generate a session title".to_owned()
                            }));
                        }
                        return Ok(normalize_generated_session_title(&latest_text));
                    }
                    RuntimeEvent::RuntimeError { message, .. } => return Err(message),
                    RuntimeEvent::ProcessState {
                        state: PiProcessState::Failed | PiProcessState::Stopped,
                        ..
                    } => {
                        return Err("Pi naming process stopped before producing a title".to_owned());
                    }
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| "Pi session title generation timed out".to_owned())?
    }
    .await;

    let stop_result = session.stop().await;
    match (result, stop_result) {
        (Ok(title), _) => Ok(title),
        (Err(error), _) => Err(error),
    }
}

#[tauri::command]
pub async fn session_generate_title(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    message: String,
) -> Result<Option<String>, String> {
    generate_session_title(&app, &runtime, &project_id, &message).await
}
