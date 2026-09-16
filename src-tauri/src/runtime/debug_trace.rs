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

pub(crate) fn runtime_trace(
    stage: &str,
    session_key: Option<&str>,
    stream_id: Option<&str>,
    detail: Value,
) {
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

    #[cfg(not(debug_assertions))]
    {
        let _ = (stage, session_key, stream_id, detail);
    }
}

pub(crate) fn append_frontend_trace(payload: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let detail = serde_json::from_str::<Value>(payload)
            .unwrap_or_else(|_| json!({ "payload": payload }));
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

    #[cfg(not(debug_assertions))]
    let _ = payload;

    Ok(())
}
