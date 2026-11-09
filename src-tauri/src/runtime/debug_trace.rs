use serde_json::{Value, json};

#[cfg(debug_assertions)]
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(debug_assertions)]
fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn append_record(record: &Value) {
    let path =
        std::env::temp_dir().join(format!("pilo-runtime-trace-{}.jsonl", std::process::id()));
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let mut line = record.to_string();
    line.push('\n');
    let _ = file.write_all(line.as_bytes());
}

fn log_runtime_diagnostic(
    source: &str,
    stage: &str,
    session_key: Option<&str>,
    stream_id: Option<&str>,
    detail: &Value,
) {
    let event = detail
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let selected = match stage {
        "channel.send" | "channel.drop_no_subscriber" | "webview.recv" => matches!(
            event,
            "process_state" | "rpc_message" | "runtime_error" | "assistant_message_end"
        ),
        "server_pi.recv" => matches!(
            event,
            "response" | "agent_start" | "agent_end" | "agent_settled"
        ),
        _ => {
            stage.starts_with("chat.")
                || stage.starts_with("model_catalog.")
                || stage.starts_with("next_prompt.")
                || matches!(
                    stage,
                    "channel.subscribe"
                        | "channel.unsubscribe"
                        | "channel.send_error"
                        | "webview.channel.subscribe.begin"
                        | "webview.channel.subscribe.end"
                        | "webview.rpc.begin"
                        | "webview.rpc.end"
                )
        }
    };
    if !selected {
        return;
    }
    // Release logs contain identifiers/status only, never RPC bodies or raw errors.
    let metadata = detail.get("eventDetail").unwrap_or(detail);
    let mut safe = serde_json::Map::new();
    for key in [
        "projectId",
        "connectionId",
        "catalogSource",
        "modelCount",
        "commandCount",
        "hasSessionPath",
        "noSession",
        "ok",
        "cached",
        "generation",
        "state",
        "command",
        "id",
        "requestId",
        "revision",
        "status",
        "outputTokens",
        "reasoningTokens",
        "ready",
        "expectedGeneration",
        "compacting",
        "cancel",
        "reason",
        "found",
        "prepared",
        "initialized",
        "activeTurn",
        "windowLabel",
        "clientId",
        "timeoutMs",
        "elapsedMs",
        "lockWaitMs",
        "success",
        "code",
        "stopReason",
        "hasError",
        "timedOut",
        "sequence",
        "payloadBytes",
        "channelId",
        "sendCompleted",
        "responseReceived",
    ] {
        if let Some(value) = metadata.get(key).or_else(|| detail.get(key))
            && !value.is_object()
            && !value.is_array()
        {
            safe.insert(key.to_owned(), value.clone());
        }
    }
    let record = json!({
        "pid": std::process::id(), "source": source, "stage": stage,
        "sessionKey": session_key, "streamId": stream_id,
        "event": event, "detail": safe,
    });
    if metadata.get("ok").and_then(Value::as_bool) == Some(false)
        || metadata.get("success").and_then(Value::as_bool) == Some(false)
        || matches!(stage, "channel.send_error" | "channel.drop_no_subscriber")
        || event == "runtime_error"
    {
        log::warn!(target: "runtime-diagnostics", "{record}");
    } else {
        log::info!(target: "runtime-diagnostics", "{record}");
    }
}

pub(crate) fn runtime_trace(
    stage: &str,
    session_key: Option<&str>,
    stream_id: Option<&str>,
    detail: Value,
) {
    log_runtime_diagnostic("tauri", stage, session_key, stream_id, &detail);
    #[cfg(debug_assertions)]
    append_record(&json!({
        "tsMs": timestamp_ms(),
        "pid": std::process::id(),
        "source": "tauri",
        "stage": stage,
        "sessionKey": session_key,
        "streamId": stream_id,
        "detail": detail,
    }));
}

pub(crate) fn append_frontend_trace(payload: &str) -> Result<(), String> {
    let detail =
        serde_json::from_str::<Value>(payload).unwrap_or_else(|_| json!({ "payload": payload }));
    let stage = detail
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("webview.recv");
    log_runtime_diagnostic(
        "webview",
        stage,
        detail.get("sessionKey").and_then(Value::as_str),
        None,
        &detail,
    );
    #[cfg(debug_assertions)]
    {
        let stage = detail
            .get("stage")
            .and_then(Value::as_str)
            .unwrap_or("webview.recv")
            .to_owned();
        let session_key = detail.get("sessionKey").cloned().unwrap_or(Value::Null);
        append_record(&json!({
            "tsMs": timestamp_ms(),
            "pid": std::process::id(),
            "source": "webview",
            "stage": stage,
            "sessionKey": session_key,
            "streamId": Value::Null,
            "detail": detail,
        }));
    }

    Ok(())
}
