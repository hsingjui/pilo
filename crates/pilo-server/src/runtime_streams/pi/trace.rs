#[cfg(debug_assertions)]
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

pub(super) fn trace_pi(stage: &str, stream_id: &str, detail: Value) {
    if matches!(stage, "pi.start" | "pi.stop" | "pi.stdout_closed") {
        eprintln!(
            "[runtime-diagnostics] {}",
            json!({
                "pid": std::process::id(), "stage": stage, "streamId": stream_id, "detail": detail,
            })
        );
    }
    #[cfg(debug_assertions)]
    {
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let record = json!({
            "tsMs": ts_ms,
            "pid": std::process::id(),
            "source": "pilo-server",
            "stage": stage,
            "sessionKey": Value::Null,
            "streamId": stream_id,
            "detail": detail,
        });
        let path =
            std::env::temp_dir().join(format!("pilo-runtime-trace-{}.jsonl", std::process::id()));
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        let mut line = record.to_string();
        line.push('\n');
        let _ = file.write_all(line.as_bytes());
    }
}

pub(super) fn trace_pi_rpc_line(stream_id: &str, bytes: &[u8]) {
    #[cfg(debug_assertions)]
    {
        let Ok(message) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        let Some(event_type) = message.get("type").and_then(Value::as_str) else {
            return;
        };
        let traceable = matches!(
            event_type,
            "response"
                | "agent_start"
                | "agent_end"
                | "agent_settled"
                | "turn_start"
                | "turn_end"
                | "message_start"
                | "message_end"
                | "tool_execution_start"
                | "tool_execution_end"
                | "queue_update"
                | "compaction_start"
                | "compaction_end"
                | "auto_retry_start"
                | "auto_retry_end"
        );
        if !traceable {
            return;
        }
        let role = message.pointer("/message/role").and_then(Value::as_str);
        let stop_reason = message
            .pointer("/message/stopReason")
            .and_then(Value::as_str);
        trace_pi(
            "pi.stdout",
            stream_id,
            json!({
                "event": event_type,
                "id": message.get("id"),
                "command": message.get("command"),
                "success": message.get("success"),
                "role": role,
                "stopReason": stop_reason,
                "willRetry": message.get("willRetry"),
                "toolCallId": message.get("toolCallId"),
                "toolName": message.get("toolName"),
            }),
        );
    }

    #[cfg(not(debug_assertions))]
    let _ = (stream_id, bytes);
}
