//! Conversions from runtime values to the JSON the TSX client reads.

use nsh_core::JsonValue;
use pilo_runtime::{Runtime, events::EventBatch, project_api::project_list};
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
