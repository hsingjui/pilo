//! Conversions from runtime values to the JSON the TSX client reads.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use nsh_core::JsonValue;
use pilo_runtime::{Runtime, TerminalEvent, events::EventBatch, project_api::project_list};
use serde::Serialize;

use super::objects::NativeHistoryFingerprint;

pub(super) fn encode_list(values: Vec<impl Serialize>) -> Result<Vec<JsonValue>, String> {
    values
        .into_iter()
        .map(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        .collect()
}

pub(super) fn encode_event_batch(batch: EventBatch) -> Result<JsonValue, String> {
    Ok(match batch {
        EventBatch::Events(events) => serde_json::json!({
            "type": "events",
            "events": encode_list(events.iter().map(AsRef::as_ref).collect())?,
        }),
        EventBatch::Gap {
            first_missed,
            last_missed,
        } => serde_json::json!({
            "type": "gap",
            "firstMissed": first_missed,
            "lastMissed": last_missed,
        }),
        EventBatch::Closed => serde_json::json!({ "type": "closed" }),
    })
}

pub(super) fn encode_terminal_events(events: Vec<TerminalEvent>) -> Vec<JsonValue> {
    events
        .into_iter()
        .map(|event| match event {
            TerminalEvent::Output { terminal_id, data } => serde_json::json!({
                "type": "output",
                "terminalId": terminal_id,
                "data": BASE64.encode(data),
            }),
            TerminalEvent::Exit { terminal_id } => serde_json::json!({
                "type": "exit",
                "terminalId": terminal_id,
            }),
            TerminalEvent::Error {
                terminal_id,
                message,
            } => serde_json::json!({
                "type": "error",
                "terminalId": terminal_id,
                "message": message,
            }),
        })
        .collect()
}

pub(super) fn load_projects(runtime: &Runtime) -> Result<Vec<JsonValue>, String> {
    encode_list(project_list(runtime)?)
}

pub(super) fn history_fingerprint_args(
    fingerprint: Option<NativeHistoryFingerprint>,
) -> Result<(Option<u64>, Option<String>), String> {
    let Some(fingerprint) = fingerprint else {
        return Ok((None, None));
    };
    let size = fingerprint.file_size;
    if !(0.0..=9_007_199_254_740_991.0).contains(&size) || size.fract() != 0.0 {
        return Err("session history file size must be a non-negative safe integer".into());
    }
    Ok((Some(size as u64), Some(fingerprint.file_mtime_ns)))
}

/// A count the TSX client passes as a number: a positive safe integer.
pub(super) fn positive_count(value: f64, name: &str) -> Result<usize, String> {
    let invalid = || format!("{name} must be a positive safe integer");
    if !(1.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
        return Err(invalid());
    }
    usize::try_from(value as u64).map_err(|_| invalid())
}

/// A terminal's columns and rows: whole numbers from 1 to 65,535.
pub(super) fn terminal_size(cols: f64, rows: f64) -> Result<(u16, u16), String> {
    let cell = |value: f64| {
        (value >= 1.0 && value <= f64::from(u16::MAX) && value.fract() == 0.0)
            .then_some(value as u16)
            .ok_or("terminal size must be whole numbers from 1 to 65535")
    };
    Ok((cell(cols)?, cell(rows)?))
}
