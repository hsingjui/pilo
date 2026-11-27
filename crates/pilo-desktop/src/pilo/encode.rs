//! Conversions from runtime values to the JSON the TSX client reads.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use nsh_core::JsonValue;
use pilo_runtime::{TerminalEvent, events::EventBatch};
use serde::Serialize;

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
    let mut coalesced: Vec<TerminalEvent> = Vec::with_capacity(events.len());
    for event in events {
        match event {
            TerminalEvent::Output {
                terminal_id,
                data,
                start_offset,
            } => {
                if let Some(TerminalEvent::Output {
                    terminal_id: prev_id,
                    data: prev_data,
                    ..
                }) = coalesced.last_mut()
                    && *prev_id == terminal_id
                {
                    prev_data.extend_from_slice(&data);
                    continue;
                }
                coalesced.push(TerminalEvent::Output {
                    terminal_id,
                    data,
                    start_offset,
                });
            }
            other => coalesced.push(other),
        }
    }
    coalesced
        .into_iter()
        .map(|event| match event {
            TerminalEvent::Output {
                terminal_id, data, ..
            } => serde_json::json!({
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

/// A count the TSX client passes as a number: a positive safe integer.
pub(super) fn positive_count(value: f64, name: &str) -> Result<usize, String> {
    let invalid = || format!("{name} must be a positive safe integer");
    if !(1.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
        return Err(invalid());
    }
    usize::try_from(value as u64).map_err(|_| invalid())
}
