use std::time::Duration;

use tauri::{AppHandle, State};

use crate::runtime::{PiloRuntime, pi_oneshot, project, server_pi::PiLaunchOptions, storage};

const SESSION_NAMING_SYSTEM_PROMPT: &str = "Generate a concise title for a coding conversation from the user's first message. Return exactly one plain-text title with no quotes, markdown, explanation, prefix, or suffix. Use the same language as the user. Prefer at most 24 CJK characters or 60 Latin characters.";

const SESSION_NAMING_TIMEOUT: Duration = Duration::from_secs(45);

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

    let title = pi_oneshot::generate_text(
        app,
        runtime,
        project_id,
        PiLaunchOptions {
            no_session: true,
            disable_resources: true,
            provider: Some(naming_model.provider),
            model: Some(naming_model.model_id),
            thinking: Some("off".to_owned()),
            system_prompt: Some(SESSION_NAMING_SYSTEM_PROMPT.to_owned()),
            ..PiLaunchOptions::default()
        },
        message.to_owned(),
        SESSION_NAMING_TIMEOUT,
    )
    .await?;

    Ok(normalize_generated_session_title(&title))
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
