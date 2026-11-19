use std::time::Duration;

use crate::runtime::Runtime;
#[cfg(feature = "tauri")]
use crate::runtime::{pi_oneshot, project, server_pi::PiLaunchOptions, storage};

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

#[cfg(feature = "tauri")]
pub async fn generate_session_title(
    runtime: &Runtime,
    project_id: &str,
    message: &str,
) -> Result<Option<String>, String> {
    let message = message.trim();
    if message.is_empty() {
        return Ok(None);
    }

    let project = project::get(runtime, project_id)?;
    let naming_model = storage::get_connection_naming_model(
        &storage::open(&runtime.paths)?,
        &project.connection.id,
    )?;
    let Some(naming_model) = naming_model else {
        return Ok(None);
    };

    let title = pi_oneshot::generate_text(
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

#[cfg(feature = "tauri")]
pub async fn session_generate_title(
    runtime: &Runtime,
    project_id: String,
    message: String,
) -> Result<Option<String>, String> {
    generate_session_title(runtime, &project_id, &message).await
}

#[cfg(test)]
mod tests {
    use super::normalize_generated_session_title;

    #[test]
    fn normalizes_titles_and_ignores_empty_output() {
        assert_eq!(
            normalize_generated_session_title("\n  \"Fix the parser\"\nignored"),
            Some("Fix the parser".into())
        );
        assert_eq!(normalize_generated_session_title(" \n "), None);
        assert_eq!(normalize_generated_session_title("***"), None);
        assert_eq!(
            normalize_generated_session_title(&"文".repeat(81)),
            Some(format!("{}…", "文".repeat(80)))
        );
    }
}
