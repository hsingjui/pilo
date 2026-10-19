//! Composer prompt enhancement.
//!
//! Rewrites the user's draft into a clearer, more actionable prompt. The call
//! runs on a throwaway Pi process, so it never joins a conversation, never
//! consumes the chat session's queue and stays available while another turn is
//! still running. It never answers the request itself.
//!
//! Desktop and the Remote WebUI share this module through the Tauri commands
//! and the authenticated HTTP routes; the settings row is the same SQLite row,
//! keyed by the original project's Connection.

use std::time::Duration;

use tauri::AppHandle;

use crate::domain::{PromptEnhancementModel, PromptEnhancementSettings};

use super::{
    PiloRuntime, RuntimeEventBus,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    host_paths::HostPaths,
    pi_oneshot, project,
    server_pi::PiLaunchOptions,
    storage,
};

const PROMPT_ENHANCEMENT_SYSTEM_PROMPT: &str = "You rewrite a user's draft prompt into a clearer, more actionable prompt for a coding agent. Rules: Keep the author's intent; do NOT answer the request, add answers, or start doing the task. Preserve file paths, code snippets, commands, and references verbatim. Make implicit goals explicit: task, scope, constraints, and the expected result. Remove filler; keep the prompt concise but complete. Reply in the same language as the draft. Output ONLY the rewritten prompt text without preamble, quotes, or markdown fences.";

/// Must stay below the Remote WebUI Router's 45s `TimeoutLayer`, otherwise the
/// outer layer answers 408 and the real reason never reaches the client.
const PROMPT_ENHANCEMENT_TIMEOUT: Duration = Duration::from_secs(40);

/// Long drafts are clipped before they reach the model; the tail is what the
/// user is actively writing, but the head carries the task statement, so keep
/// both ends instead of a single prefix.
const MAX_DRAFT_CHARS: usize = 32_000;

pub(crate) fn load(
    paths: &HostPaths,
    connection_id: &str,
) -> Result<PromptEnhancementSettings, String> {
    storage::get_prompt_enhancement_settings(&storage::open_with_paths(paths)?, connection_id)
}

pub(crate) fn save(
    paths: &HostPaths,
    events: &RuntimeEventBus,
    connection_id: &str,
    enabled: bool,
    model: Option<PromptEnhancementModel>,
) -> Result<PromptEnhancementSettings, String> {
    let settings = storage::set_prompt_enhancement_settings(
        &storage::open_with_paths(paths)?,
        connection_id,
        enabled,
        model,
    )?;
    events.send(RuntimeEventEnvelope {
        session_key: None,
        project_id: None,
        timestamp_ms: None,
        event: RuntimeEvent::PromptEnhancementSettingsChanged {
            settings: settings.clone(),
        },
    });
    Ok(settings)
}

fn clip_draft(draft: &str) -> String {
    if draft.chars().count() <= MAX_DRAFT_CHARS {
        return draft.to_owned();
    }
    let budget = MAX_DRAFT_CHARS / 2;
    let head: String = draft.chars().take(budget).collect();
    let tail: String = draft
        .chars()
        .rev()
        .take(budget)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head}\n…\n{tail}")
}

/// Strip a Markdown fence only when it wraps the whole reply.
///
/// A reply that merely ends with a code block is ordinary prompt text: removing
/// its closing fence would hand the composer a broken snippet, so the opening
/// fence has to start the reply and its closing fence has to end it.
fn strip_outer_fence(value: &str) -> &str {
    let Some(rest) = value.strip_prefix("```") else {
        return value;
    };
    let Some((opening, body)) = rest.split_once('\n') else {
        return value;
    };
    if opening.contains('`') {
        return value;
    }
    let Some(inner) = body.trim_end().strip_suffix("```") else {
        return value;
    };
    // An earlier closing fence belongs to a code block, not an outer wrapper.
    if body.lines().last().map(str::trim) != Some("```")
        || inner.lines().any(|line| {
            let fence = line.trim();
            fence.len() >= 3 && fence.bytes().all(|byte| byte == b'`')
        })
    {
        return value;
    }
    inner.trim()
}

/// Strip wrapping quotes only when a single pair encloses the whole reply.
///
/// `"foo" 和 "bar"` starts and ends with a quote yet keeps meaningful inner
/// quotes, so it must survive untouched.
fn strip_outer_quotes(value: &str) -> &str {
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return value;
    };
    if inner.contains('"') {
        return value;
    }
    inner.trim()
}

/// Strip an accidental markdown fence or wrapping quotes from the model reply.
fn normalize_enhanced_prompt(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let unquoted = strip_outer_quotes(strip_outer_fence(trimmed)).trim();
    (!unquoted.is_empty()).then(|| unquoted.to_owned())
}

fn resolve_model(
    settings: &PromptEnhancementSettings,
    fallback: Option<PromptEnhancementModel>,
) -> Result<(Option<String>, Option<String>), String> {
    let Some(model) = settings.model.clone().or(fallback) else {
        return Ok((None, None));
    };
    let provider = model.provider.trim().to_owned();
    let id = model.id.trim().to_owned();
    if provider.is_empty() || id.is_empty() {
        return Err("Invalid enhancement model".to_owned());
    }
    Ok((Some(provider), Some(id)))
}

pub(crate) async fn enhance(
    app: &AppHandle,
    runtime: &PiloRuntime,
    paths: &HostPaths,
    project_id: &str,
    draft: &str,
    model: Option<PromptEnhancementModel>,
) -> Result<String, String> {
    let draft = draft.trim();
    if draft.is_empty() {
        return Err("Draft is empty".to_owned());
    }

    let project = project::get(app, project_id)?;
    let settings = load(paths, &project.connection.id)?;
    if !settings.enabled {
        return Err("Prompt enhancement is disabled for this connection".to_owned());
    }
    // A configured model wins; otherwise follow the chat's current selection.
    let (provider, model_id) = resolve_model(&settings, model)?;

    let text = pi_oneshot::generate_text(
        app,
        runtime,
        project_id,
        PiLaunchOptions {
            no_session: true,
            disable_resources: true,
            provider,
            model: model_id,
            thinking: Some("off".to_owned()),
            system_prompt: Some(PROMPT_ENHANCEMENT_SYSTEM_PROMPT.to_owned()),
            ..PiLaunchOptions::default()
        },
        clip_draft(draft),
        PROMPT_ENHANCEMENT_TIMEOUT,
    )
    .await?;

    normalize_enhanced_prompt(&text).ok_or_else(|| "Model returned no prompt text".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{MAX_DRAFT_CHARS, clip_draft, normalize_enhanced_prompt};

    #[test]
    fn keeps_short_drafts_untouched() {
        assert_eq!(clip_draft("fix the parser"), "fix the parser");
    }

    #[test]
    fn clips_long_drafts_keeping_both_ends() {
        let draft = format!("{}{}", "a".repeat(MAX_DRAFT_CHARS), "TAIL");
        let clipped = clip_draft(&draft);
        assert!(clipped.starts_with(&"a".repeat(MAX_DRAFT_CHARS / 2)));
        assert!(clipped.ends_with("TAIL"));
        assert!(clipped.chars().count() < draft.chars().count());
    }

    #[test]
    fn strips_a_reply_wrapped_in_a_fence() {
        assert_eq!(
            normalize_enhanced_prompt("```\nRewrite this\n```").as_deref(),
            Some("Rewrite this")
        );
        assert_eq!(
            normalize_enhanced_prompt("```markdown\nRewrite this\n```").as_deref(),
            Some("Rewrite this")
        );
    }

    #[test]
    fn keeps_code_blocks_inside_the_prompt() {
        let reply = "Rewrite `parse` so that:\n\n```rust\nfn parse() {}\n```";
        assert_eq!(normalize_enhanced_prompt(reply).as_deref(), Some(reply));
    }

    #[test]
    fn keeps_separate_leading_and_trailing_code_blocks() {
        for (newline, closing) in [("\n", "```"), ("\r\n", "```"), ("\n", "````")] {
            let reply = [
                "```rust",
                "fn before() {}",
                closing,
                "",
                "Change the implementation to this interface:",
                "",
                "```rust",
                "fn after() {}",
                "```",
            ]
            .join(newline);
            assert_eq!(
                normalize_enhanced_prompt(&reply).as_deref(),
                Some(reply.as_str())
            );
        }
    }

    #[test]
    fn keeps_a_closing_fence_inside_a_code_line() {
        let reply = "```text\nPreserve this literal: ```";
        assert_eq!(normalize_enhanced_prompt(reply).as_deref(), Some(reply));
    }

    #[test]
    fn keeps_an_unclosed_leading_fence() {
        let reply = "```rust\nfn parse() {}\n\nand explain it";
        assert_eq!(normalize_enhanced_prompt(reply).as_deref(), Some(reply));
    }

    #[test]
    fn strips_wrapping_quotes_only_when_a_single_pair_wraps_the_reply() {
        assert_eq!(
            normalize_enhanced_prompt("\"Rewrite this\"").as_deref(),
            Some("Rewrite this")
        );
        assert_eq!(
            normalize_enhanced_prompt("\"foo\" 和 \"bar\"").as_deref(),
            Some("\"foo\" 和 \"bar\"")
        );
    }

    #[test]
    fn rejects_an_empty_reply() {
        assert_eq!(normalize_enhanced_prompt("   \n  "), None);
        assert_eq!(normalize_enhanced_prompt("```\n```"), None);
    }
}
