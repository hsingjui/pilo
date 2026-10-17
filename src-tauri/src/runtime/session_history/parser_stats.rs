use serde_json::Value;

use super::super::token_usage::TokenUsage;
use super::types::SessionHistoryStats;

pub(super) fn collect_history_stats(entries: &[Value], branch: &[usize]) -> SessionHistoryStats {
    let mut stats = SessionHistoryStats::default();

    for entry in entries {
        match entry.get("type").and_then(Value::as_str) {
            Some("message") => {
                let Some(message) = entry.get("message") else {
                    continue;
                };
                let role = message.get("role").and_then(Value::as_str);
                if role == Some("system") {
                    continue;
                }
                stats.total_messages += 1;
                match role {
                    Some("user") => stats.user_messages += 1,
                    Some("toolResult") => {
                        stats.tool_results += 1;
                        add_usage(&mut stats, message.get("usage"));
                    }
                    Some("assistant") => {
                        stats.assistant_messages += 1;
                        stats.tool_calls += message
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|content| {
                                content
                                    .iter()
                                    .filter(|item| {
                                        item.get("type").and_then(Value::as_str) == Some("toolCall")
                                    })
                                    .count()
                            })
                            .unwrap_or(0);
                        add_usage(&mut stats, message.get("usage"));
                    }
                    _ => {}
                }
            }
            Some("branch_summary") | Some("compaction") => {
                add_usage(&mut stats, entry.get("usage"));
            }
            _ => {}
        }
    }

    stats.context_tokens = current_branch_context_tokens(entries, branch);
    stats
}

fn add_usage(stats: &mut SessionHistoryStats, usage: Option<&Value>) {
    // 字段映射与单条消息的用量共用一处；会话合计仍是四个计数器相加，
    // 不采用 `totalTokens`，以免改变既有统计口径。
    let Some(usage) = TokenUsage::from_json(usage) else {
        return;
    };
    let total = usage
        .input
        .saturating_add(usage.output)
        .saturating_add(usage.cache_read)
        .saturating_add(usage.cache_write);

    stats.tokens.input = stats.tokens.input.saturating_add(usage.input);
    stats.tokens.output = stats.tokens.output.saturating_add(usage.output);
    stats.tokens.cache_read = stats.tokens.cache_read.saturating_add(usage.cache_read);
    stats.tokens.cache_write = stats.tokens.cache_write.saturating_add(usage.cache_write);
    stats.tokens.total = stats.tokens.total.saturating_add(total);
    stats.cost += usage.cost.unwrap_or(0.0);
}

fn current_branch_context_tokens(entries: &[Value], branch: &[usize]) -> Option<u64> {
    let start = branch
        .iter()
        .rposition(|index| {
            entries[*index].get("type").and_then(Value::as_str) == Some("compaction")
        })
        .map(|position| position + 1)
        .unwrap_or(0);

    for index in branch[start..].iter().rev() {
        let entry = &entries[*index];
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if matches!(
            message.get("stopReason").and_then(Value::as_str),
            Some("aborted" | "error")
        ) {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let total = usage
            .get("totalTokens")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                ["input", "output", "cacheRead", "cacheWrite"]
                    .into_iter()
                    .filter_map(|key| usage.get(key).and_then(Value::as_u64))
                    .fold(0_u64, u64::saturating_add)
            });
        if total > 0 {
            return Some(total);
        }
    }

    None
}
