use std::sync::Arc;

use serde_json::Value;

use crate::domain::Project;
use crate::runtime::server_client::ServerManager;

use super::{
    cache::{
        SessionFileFingerprint, SessionHistoryCache, SessionHistoryWindowIndex, cache_key,
        fingerprint_from_metadata,
    },
    disk::DiskHistory,
    parser::HistoryParser,
    serialize::{
        serialize_history_response, serialize_history_window_response, serialize_windowed_history,
    },
    types::SessionHistory,
};

const HISTORY_CHANGED_DURING_READ: &str = "session changed while history was being read";
const HISTORY_CHANGED_READ_RETRIES: usize = 2;

pub(super) async fn acquire_cold_load() -> Result<Arc<tokio::sync::OwnedSemaphorePermit>, String> {
    static SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    Arc::clone(SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2))))
        .acquire_owned()
        .await
        .map(Arc::new)
        .map_err(|_| "session history loading is shutting down".to_owned())
}

pub(super) async fn read_fingerprint(
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

/// Lazily loads one user-image payload from the session JSONL is implemented in
/// [`super::images`].
pub async fn read_history_json(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    expected_fingerprint: Option<(u64, u64)>,
) -> Result<Vec<u8>, String> {
    let (storage, _, fingerprint) =
        load_history(servers, cache, project, path, expected_fingerprint).await?;
    match storage {
        HistoryStorage::Memory(serialized) => {
            Ok(serialize_history_response(&serialized, fingerprint))
        }
        HistoryStorage::Disk(file) => {
            tokio::task::spawn_blocking(move || file.read_full(fingerprint))
                .await
                .map_err(|error| format!("history cache read task failed: {error}"))?
        }
    }
}

// Thin pass-through from Tauri commands: splitting the arguments would only move them around.
#[allow(clippy::too_many_arguments)]
pub async fn read_history_window_json(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    expected_fingerprint: Option<(u64, u64)>,
    start_message: Option<usize>,
    message_limit: usize,
    include_message_index: bool,
) -> Result<Vec<u8>, String> {
    let (storage, index, fingerprint) =
        load_history(servers, cache, project, path, expected_fingerprint).await?;
    match storage {
        HistoryStorage::Memory(serialized) => Ok(serialize_history_window_response(
            &serialized,
            &index,
            start_message,
            message_limit,
            include_message_index,
            fingerprint,
        )),
        HistoryStorage::Disk(file) => {
            file.read_window(
                index,
                start_message,
                message_limit,
                include_message_index,
                fingerprint,
            )
            .await
        }
    }
}

enum HistoryStorage {
    Memory(Arc<Vec<u8>>),
    Disk(Arc<DiskHistory>),
}

async fn load_history(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    expected_fingerprint: Option<(u64, u64)>,
) -> Result<
    (
        HistoryStorage,
        Arc<SessionHistoryWindowIndex>,
        Option<SessionFileFingerprint>,
    ),
    String,
> {
    let key = cache_key(project, path);
    let load_lock = cache.lock().await.load_lock(&key);
    let _load_guard = load_lock.lock().await;
    let mut source_confirmed = expected_fingerprint.is_none();
    let mut fingerprint = match expected_fingerprint {
        Some((file_size, file_mtime_ns)) => Some(SessionFileFingerprint {
            file_size,
            file_mtime_ns,
        }),
        None => read_fingerprint(servers, project, path).await?,
    };
    while let Some(candidate) = fingerprint {
        let mut history_cache = cache.lock().await;
        if let Some((serialized, index)) = history_cache.get_windowed(&key, candidate) {
            return Ok((HistoryStorage::Memory(serialized), index, Some(candidate)));
        }
        if let Some((file, index)) = history_cache.get_disk(&key, candidate) {
            return Ok((HistoryStorage::Disk(file), index, Some(candidate)));
        }
        if source_confirmed || !history_cache.has_history(&key) {
            break;
        }
        // An older client window can miss even when the cache is already current.
        drop(history_cache);
        fingerprint = read_fingerprint(servers, project, path).await?;
        source_confirmed = true;
    }
    let load_permit = acquire_cold_load().await?;
    if let Some(fingerprint) = fingerprint.filter(|_| source_confirmed) {
        cache.lock().await.evict_stale_memory(&key, fingerprint);
    }
    let (history, fingerprint) =
        read_file(servers, project, path, Arc::clone(&load_permit)).await?;
    let serialization_permit = Arc::clone(&load_permit);
    let (serialized, index) = tokio::task::spawn_blocking(move || {
        // Blocking work keeps its reservation even if the HTTP caller leaves.
        let _permit = serialization_permit;
        serialize_windowed_history(history)
    })
    .await
    .map_err(|error| format!("history serialization task failed: {error}"))??;
    if let Some(fingerprint) = fingerprint {
        if SessionHistoryCache::fits_memory(fingerprint) {
            cache.lock().await.insert_windowed(
                key,
                fingerprint,
                Arc::clone(&serialized),
                Arc::clone(&index),
            );
        } else if SessionHistoryCache::fits_disk(serialized.len(), &index) {
            let data = Arc::clone(&serialized);
            let disk_permit = Arc::clone(&load_permit);
            match tokio::task::spawn_blocking(move || {
                let _permit = disk_permit;
                DiskHistory::create(&data)
            })
            .await
            .map_err(|error| format!("history cache write task failed: {error}"))?
            {
                Ok(file) => {
                    let file = Arc::new(file);
                    cache.lock().await.insert_disk(
                        key,
                        fingerprint,
                        Arc::clone(&file),
                        Arc::clone(&index),
                    );
                    return Ok((HistoryStorage::Disk(file), index, Some(fingerprint)));
                }
                Err(error) => log::warn!(target: "session-history", "{error}"),
            }
        }
    }
    Ok((HistoryStorage::Memory(serialized), index, fingerprint))
}

pub(super) async fn read_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
    load_permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    for attempt in 0..=HISTORY_CHANGED_READ_RETRIES {
        match read_file_once(servers, project, path, Arc::clone(&load_permit)).await {
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
    load_permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    const CHUNK_BYTES: usize = 16 * 1024 * 1024;
    let mut cursor = 0_u64;
    let mut parser = HistoryParser::with_load_permit(load_permit);
    let mut fingerprint = None;
    let mut snapshot_size = None;
    loop {
        let remaining = snapshot_size
            .map(|size: u64| size.saturating_sub(cursor) as usize)
            .unwrap_or(CHUNK_BYTES);
        if snapshot_size.is_some() && remaining == 0 {
            return finish_file_read(parser, fingerprint).await;
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
        let empty = chunk.is_empty();
        parser = tokio::task::spawn_blocking(move || {
            parser.push(&chunk);
            parser
        })
        .await
        .map_err(|error| format!("history parsing task failed: {error}"))?;
        if snapshot_size.is_some_and(|size| next_offset >= size) || eof {
            return finish_file_read(parser, fingerprint).await;
        }
        if empty {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        cursor = next_offset;
    }
}

async fn finish_file_read(
    parser: HistoryParser,
    fingerprint: Option<SessionFileFingerprint>,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    tokio::task::spawn_blocking(move || (parser.finish(), fingerprint))
        .await
        .map_err(|error| format!("history parsing task failed: {error}"))
}
