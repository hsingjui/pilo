//! Composer prompt enhancement.
//!
//! Rewrites the user's draft into a clearer, more actionable prompt. The call
//! runs on a throwaway Pi process, so it never joins a conversation, never
//! consumes the chat session's queue and stays available while another turn is
//! still running. It never answers the request itself.

use std::time::Duration;

use tauri::AppHandle;

use crate::domain::PromptEnhanceModel;

use super::{PiloRuntime, pi_oneshot, server_pi::PiLaunchOptions};

const PROMPT_ENHANCEMENT_SYSTEM_PROMPT: &str = "You rewrite a user's draft prompt into a clearer, more actionable prompt for a coding agent. Rules: Keep the author's intent; do NOT answer the request, add answers, or start doing the task. Preserve file paths, code snippets, commands, and references verbatim. Make implicit goals explicit: task, scope, constraints, and the expected result. Remove filler; keep the prompt concise but complete. Reply in the same language as the draft. Output ONLY the rewritten prompt text without preamble, quotes, or markdown fences.";

const PROMPT_ENHANCEMENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Long drafts are clipped before they reach the model; the tail is what the
/// user is actively writing, but the head carries the task statement, so keep
/// both ends instead of a single prefix.
const MAX_DRAFT_CHARS: usize = 32_000;

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

/// Strip an accidental markdown fence or wrapping quotes from the model reply.
fn normalize_enhanced_prompt(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let without_fence = trimmed
        .strip_prefix("```")
        .map(|rest| match rest.find('\n') {
            Some(index) if !rest[..index].contains('`') => &rest[index + 1..],
            _ => rest,
        })
        .unwrap_or(trimmed);
    let closed = without_fence
        .trim_end()
        .strip_suffix("```")
        .unwrap_or(without_fence)
        .trim();
    let unquoted = closed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(closed)
        .trim();
    (!unquoted.is_empty()).then(|| unquoted.to_owned())
}

pub(crate) async fn enhance_prompt(
    app: &AppHandle,
    runtime: &PiloRuntime,
    project_id: &str,
    model: Option<PromptEnhanceModel>,
    draft: &str,
) -> Result<String, String> {
    let draft = draft.trim();
    if draft.is_empty() {
        return Err("Draft is empty".to_owned());
    }

    let (provider, model_id) = match model {
        Some(model) => {
            let provider = model.provider.trim().to_owned();
            let model_id = model.id.trim().to_owned();
            if provider.is_empty() || model_id.is_empty() {
                return Err("Invalid model".to_owned());
            }
            (Some(provider), Some(model_id))
        }
        None => (None, None),
    };

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
    fn strips_fences_and_quotes() {
        assert_eq!(
            normalize_enhanced_prompt("```\nRewrite this\n```").as_deref(),
            Some("Rewrite this")
        );
        assert_eq!(
            normalize_enhanced_prompt("```markdown\nRewrite this\n```").as_deref(),
            Some("Rewrite this")
        );
        assert_eq!(
            normalize_enhanced_prompt("\"Rewrite this\"").as_deref(),
            Some("Rewrite this")
        );
        assert_eq!(normalize_enhanced_prompt("   \n  "), None);
    }
}
