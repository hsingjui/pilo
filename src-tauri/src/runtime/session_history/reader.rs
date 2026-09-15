use std::sync::Arc;

use serde_json::Value;

use crate::domain::Project;
use crate::runtime::server_client::ServerManager;

use super::{
    cache::{SessionFileFingerprint, SessionHistoryCache, cache_key, fingerprint_from_metadata},
    parser::HistoryParser,
    types::SessionHistory,
};

const HISTORY_CHANGED_DURING_READ: &str = "session changed while history was being read";
const HISTORY_CHANGED_READ_RETRIES: usize = 2;

fn serialize_history_response(
    serialized_history: &[u8],
    fingerprint: Option<SessionFileFingerprint>,
) -> Vec<u8> {
    let fingerprint_json = fingerprint
        .map(|fingerprint| {
            format!(
                "{{\"fileSize\":{},\"fileMtimeNs\":\"{}\"}}",
                fingerprint.file_size, fingerprint.file_mtime_ns
            )
        })
        .unwrap_or_else(|| "null".to_owned());
    let mut response = Vec::with_capacity(serialized_history.len() + fingerprint_json.len() + 40);
    response.extend_from_slice(b"{\"history\":");
    response.extend_from_slice(serialized_history);
    response.extend_from_slice(b",\"fingerprint\":");
    response.extend_from_slice(fingerprint_json.as_bytes());
    response.push(b'}');
    response
}

async fn read_fingerprint(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<Option<SessionFileFingerprint>, String> {
    let (metadata, binary) = servers
        .request_with_binary(
            &project.connection,
            "session.read",
            serde_json::json!({ "path": path, "offset": 0, "limit": 0 }),
            Vec::new(),
        )
        .await?;
    if binary.len() != 1 {
        return Err(format!(
            "session.read expected one binary attachment, got {}",
            binary.len()
        ));
    }
    Ok(fingerprint_from_metadata(&metadata))
}

pub async fn read_history_json(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    expected_fingerprint: Option<(u64, u64)>,
) -> Result<Vec<u8>, String> {
    let key = cache_key(project, path);
    if let Some((file_size, file_mtime_ns)) = expected_fingerprint {
        let fingerprint = SessionFileFingerprint {
            file_size,
            file_mtime_ns,
        };
        if let Some(serialized) = cache.lock().await.get_serialized(&key, fingerprint) {
            return Ok(serialize_history_response(
                serialized.as_ref(),
                Some(fingerprint),
            ));
        }
    } else if let Some(fingerprint) = read_fingerprint(servers, project, path).await?
        && let Some(serialized) = cache.lock().await.get_serialized(&key, fingerprint)
    {
        return Ok(serialize_history_response(
            serialized.as_ref(),
            Some(fingerprint),
        ));
    }

    let (history, fingerprint) = read_file(servers, project, path).await?;
    let history = Arc::new(history);
    let serialized = Arc::new(
        serde_json::to_vec(history.as_ref())
            .map_err(|error| format!("failed to serialize session history: {error}"))?,
    );
    if let Some(fingerprint) = fingerprint {
        cache
            .lock()
            .await
            .insert_serialized(key, fingerprint, Arc::clone(&serialized));
    }
    Ok(serialize_history_response(serialized.as_ref(), fingerprint))
}

async fn read_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    for attempt in 0..=HISTORY_CHANGED_READ_RETRIES {
        match read_file_once(servers, project, path).await {
            Err(error)
                if error == HISTORY_CHANGED_DURING_READ
                    && attempt < HISTORY_CHANGED_READ_RETRIES =>
            {
                tokio::task::yield_now().await;
            }
            result => return result,
        }
    }
    unreachable!("history retry loop always returns")
}

async fn read_file_once(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    const CHUNK_BYTES: usize = 16 * 1024 * 1024;
    let mut cursor = 0_u64;
    let mut parser = HistoryParser::default();
    let mut fingerprint = None;
    let mut snapshot_size = None;
    loop {
        let remaining = snapshot_size
            .map(|size: u64| size.saturating_sub(cursor) as usize)
            .unwrap_or(CHUNK_BYTES);
        if snapshot_size.is_some() && remaining == 0 {
            return Ok((parser.finish(), fingerprint));
        }
        let (metadata, binary) = servers
            .request_with_binary(
                &project.connection,
                "session.read",
                serde_json::json!({ "path": path, "offset": cursor, "limit": CHUNK_BYTES.min(remaining) }),
                Vec::new(),
            )
            .await?;
        if binary.len() != 1 {
            return Err(format!(
                "session.read expected one binary attachment, got {}",
                binary.len()
            ));
        }
        if let Some(chunk_fingerprint) = fingerprint_from_metadata(&metadata) {
            match fingerprint {
                Some(existing) => {
                    let target_size = snapshot_size.unwrap_or(existing.file_size);
                    if chunk_fingerprint.file_size < target_size
                        || (chunk_fingerprint.file_size == target_size
                            && chunk_fingerprint.file_mtime_ns != existing.file_mtime_ns)
                    {
                        return Err(HISTORY_CHANGED_DURING_READ.to_owned());
                    }
                }
                None => {
                    snapshot_size = Some(chunk_fingerprint.file_size);
                    fingerprint = Some(chunk_fingerprint);
                }
            }
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
        if next_offset != cursor.saturating_add(chunk.len() as u64) {
            return Err("invalid pilo-server session chunk offset".to_owned());
        }
        parser.push(&chunk);
        if snapshot_size.is_some_and(|size| next_offset >= size) || eof {
            return Ok((parser.finish(), fingerprint));
        }
        if chunk.is_empty() {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        cursor = next_offset;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_response_includes_the_actual_file_fingerprint() {
        let response = serialize_history_response(
            br#"{"events":[],"model":null,"thinkingLevel":null,"name":null,"sourceMessageCount":0}"#,
            Some(SessionFileFingerprint {
                file_size: 123,
                file_mtime_ns: u64::MAX,
            }),
        );
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["history"]["events"], serde_json::json!([]));
        assert_eq!(value["fingerprint"]["fileSize"], 123);
        assert_eq!(value["fingerprint"]["fileMtimeNs"], u64::MAX.to_string());
    }
}
