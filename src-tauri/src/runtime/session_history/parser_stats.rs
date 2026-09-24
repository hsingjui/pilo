use serde_json::Value;

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
    let Some(usage) = usage else {
        return;
    };
    let input = usage.get("input").and_then(Value::as_u64).unwrap_or(0);
    let output = usage.get("output").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = usage.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
    let cache_write = usage.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0);

    stats.tokens.input = stats.tokens.input.saturating_add(input);
    stats.tokens.output = stats.tokens.output.saturating_add(output);
    stats.tokens.cache_read = stats.tokens.cache_read.saturating_add(cache_read);
    stats.tokens.cache_write = stats.tokens.cache_write.saturating_add(cache_write);
    stats.tokens.total = stats.tokens.total.saturating_add(
        input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write),
    );
    stats.cost += usage
        .get("cost")
        .and_then(|cost| cost.get("total"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
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
