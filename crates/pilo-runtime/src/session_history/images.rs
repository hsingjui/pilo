use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use serde_json::Value;

use crate::{host_api::ImageReadError, server_client::ServerManager};
use pilo_domain::Project;

use super::{
    cache::{SessionFileFingerprint, SessionHistoryCache, cache_key},
    reader::{acquire_cold_load, read_file, read_fingerprint},
};

const SESSION_RANGE_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Lazily loads one user-image payload from the session JSONL. The image id is
/// `{entryId}:{contentIndex}` as emitted on `UserMessageStart.images`.
pub async fn read_history_image_bytes(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    image_id: &str,
    expected_fingerprint: Option<(u64, u64)>,
) -> Result<Vec<u8>, ImageReadError> {
    let key = cache_key(&project.id, path);
    let load_lock = cache.lock().await.load_lock(&key);
    let load_guard = load_lock.lock().await;
    let fingerprint = match expected_fingerprint {
        Some((file_size, file_mtime_ns)) => SessionFileFingerprint {
            file_size,
            file_mtime_ns,
        },
        None => read_fingerprint(servers, project, path)
            .await?
            .ok_or_else(|| "session file metadata is unavailable".to_owned())?,
    };

    let locations = if let Some((_, index)) = cache.lock().await.get_windowed(&key, fingerprint) {
        Arc::clone(&index.image_locations)
    } else if let Some(locations) = cache.lock().await.get_image_locations(&key, fingerprint) {
        locations
    } else {
        let load_permit = acquire_cold_load().await?;
        let (history, parsed_fingerprint) = read_file(servers, project, path, load_permit).await?;
        let locations = Arc::new(history.image_locations);
        if let Some(parsed_fingerprint) = parsed_fingerprint {
            cache.lock().await.insert_image_locations(
                key,
                parsed_fingerprint,
                Arc::clone(&locations),
            );
        }
        locations
    };

    drop(load_guard);
    let location = locations
        .get(image_id)
        .ok_or_else(|| format!("session history image '{image_id}' was not found"))?;
    let line = read_session_range(
        servers,
        project,
        path,
        location.byte_offset,
        location.byte_length,
    )
    .await?;
    let image_id = image_id.to_owned();
    tokio::task::spawn_blocking(move || extract_history_image_bytes(&line, &image_id))
        .await
        .map_err(|error| format!("session history image decode task failed: {error}"))?
}

async fn read_session_range(
    servers: &ServerManager,
    project: &Project,
    path: &str,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    // The line length comes from the parsed file index, but clamp the initial
    // allocation anyway so a corrupt index cannot request a huge buffer up front.
    let mut out = Vec::with_capacity(
        usize::try_from(length)
            .unwrap_or(0)
            .min(SESSION_RANGE_CHUNK_BYTES),
    );
    let mut cursor = offset;
    let end = offset.saturating_add(length);
    while cursor < end {
        let chunk_limit = SESSION_RANGE_CHUNK_BYTES.min((end - cursor) as usize);
        let (metadata, binary) = servers
            .request_with_binary(
                &project.connection,
                "session.read",
                serde_json::json!({ "path": path, "offset": cursor, "limit": chunk_limit }),
                Vec::new(),
            )
            .await?;
        if binary.len() != 1 {
            return Err(format!(
                "session.read expected one binary attachment, got {}",
                binary.len()
            ));
        }
        let chunk = binary.into_iter().next().expect("binary length checked");
        let next_offset = metadata
            .get("nextOffset")
            .and_then(Value::as_u64)
            .ok_or_else(|| "pilo-server session chunk is missing nextOffset".to_owned())?;
        let eof = metadata
            .get("eof")
            .and_then(Value::as_bool)
            .ok_or_else(|| "pilo-server session chunk is missing eof".to_owned())?;
        if chunk.is_empty() {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        out.extend_from_slice(&chunk);
        if next_offset != cursor.saturating_add(chunk.len() as u64) {
            return Err("invalid pilo-server session chunk offset".to_owned());
        }
        cursor = next_offset;
        if eof && cursor < end {
            return Err("session file ended before the image range was fully read".to_owned());
        }
    }
    Ok(out)
}

fn decoded_base64_len(encoded: &str) -> usize {
    let trimmed = encoded.trim_end_matches('=');
    (trimmed.len() / 4) * 3
        + match trimmed.len() % 4 {
            2 => 1,
            3 => 2,
            _ => 0,
        }
}

fn extract_history_image_bytes(line: &[u8], image_id: &str) -> Result<Vec<u8>, ImageReadError> {
    let (base_id, content_index) = image_id
        .rsplit_once(':')
        .ok_or_else(|| format!("invalid session history image id '{image_id}'"))?;
    let content_index: usize = content_index
        .parse()
        .map_err(|_| format!("invalid session history image id '{image_id}'"))?;
    let entry: Value = serde_json::from_slice(line)
        .map_err(|error| format!("failed to parse session history image line: {error}"))?;
    if entry.get("id").and_then(Value::as_str) != Some(base_id) {
        return Err(
            format!("session history image '{image_id}' points at an unrelated entry").into(),
        );
    }
    let part = entry
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .and_then(|parts| parts.get(content_index))
        .ok_or_else(|| format!("session history image '{image_id}' content is missing"))?;
    if part.get("type").and_then(Value::as_str) != Some("image") {
        return Err(format!("session history image '{image_id}' content is not an image").into());
    }
    let data = part
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("session history image '{image_id}' payload is missing"))?;
    if decoded_base64_len(data) > crate::host_api::MAX_BLOB_OUTPUT_BYTES {
        return Err(ImageReadError::TooLarge(format!(
            "session history image '{image_id}' exceeds the 10 MB limit"
        )));
    }
    STANDARD
        .decode(data)
        .or_else(|_| STANDARD_NO_PAD.decode(data))
        .map_err(|error| {
            format!("failed to decode session history image '{image_id}': {error}").into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_image_bytes_are_decoded_from_the_target_content_part() {
        let line = r#"{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"text","text":"看"},{"type":"image","data":"aGk=","mimeType":"image/png"}]}}"#;
        let bytes = extract_history_image_bytes(line.as_bytes(), "u2:1").unwrap();
        assert_eq!(bytes, b"hi");
    }

    #[test]
    fn history_image_bytes_reject_unknown_ids_and_non_image_parts() {
        let line = br#"{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"image","data":"aGk=","mimeType":"image/png"}]}}"#;
        assert!(extract_history_image_bytes(line, "u2").is_err());
        assert!(extract_history_image_bytes(line, "u2:1").is_err());
        assert!(extract_history_image_bytes(line, "other:0").is_err());
    }

    #[test]
    fn history_image_bytes_reject_oversized_base64_before_decoding() {
        // Invalid base64 characters would fail decoding if decoded, so hitting the size error
        // proves we reject from the encoded length before decoding.
        let oversized_encoded = "!".repeat((crate::host_api::MAX_BLOB_OUTPUT_BYTES / 3 + 2) * 4);
        let line = format!(
            r#"{{"type":"message","id":"u3","message":{{"role":"user","content":[{{"type":"image","data":"{oversized_encoded}","mimeType":"image/png"}}]}}}}"#
        );
        let err = extract_history_image_bytes(line.as_bytes(), "u3:0").unwrap_err();
        assert!(
            matches!(&err, ImageReadError::TooLarge(message) if message.contains("exceeds the 10 MB limit")),
            "unexpected error: {err:?}"
        );
    }
}
