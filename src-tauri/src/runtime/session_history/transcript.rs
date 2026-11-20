use std::{
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
    time::UNIX_EPOCH,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use super::{
    cache::{
        HistoryStorage, SessionFileFingerprint, SessionHistoryCache, SessionHistoryWindowIndex,
        cache_key,
    },
    incremental::extend_projection,
    parser::HistoryParser,
    serialize::{
        serialize_history_response, serialize_history_window_response, serialize_windowed_history,
    },
};
use crate::runtime::transcript::TranscriptWindow;

pub(super) const TAIL_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct TranscriptBase {
    pub(crate) size: u64,
    tail_digest: [u8; 32],
    metadata: Metadata,
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.created()
            .ok()
            .zip(right.created().ok())
            .is_some_and(|(a, b)| a == b)
    }
}

pub(crate) fn record_transcript_base(path: String) -> Option<Arc<TranscriptBase>> {
    let mut file = File::open(&path).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() {
        return None;
    }
    let size = before.len();
    let tail_digest = read_tail(&mut file, size).ok()?;
    let after = file.metadata().ok()?;
    let current = std::fs::metadata(path).ok()?;
    if before.len() != after.len()
        || before.len() != current.len()
        || before.modified().ok()? != after.modified().ok()?
        || before.modified().ok()? != current.modified().ok()?
        || !same_file(&before, &current)
    {
        return None;
    }
    Some(Arc::new(TranscriptBase {
        size,
        tail_digest,
        metadata: before,
    }))
}

fn read_tail(file: &mut (impl Read + Seek), size: u64) -> Result<[u8; 32], String> {
    let start = size.saturating_sub(TAIL_BYTES as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = [0; TAIL_BYTES];
    let count = (size - start) as usize;
    file.read_exact(&mut bytes[..count])
        .map_err(|error| error.to_string())?;
    if count > 0 && bytes[count - 1] != b'\n' {
        return Err("transcript prefix is not newline terminated".to_owned());
    }
    Ok(Sha256::digest(&bytes[..count]).into())
}

fn validate_base(
    file: &mut File,
    metadata: &Metadata,
    base: &TranscriptBase,
) -> Result<(), String> {
    if metadata.len() < base.size || !same_file(&base.metadata, metadata) {
        return Err("transcript prefix changed".to_owned());
    }
    if metadata.len() == base.size && metadata.modified().ok() != base.metadata.modified().ok() {
        return Err("transcript mtime changed without append".to_owned());
    }
    if read_tail(file, base.size)? != base.tail_digest {
        return Err("transcript boundary tail was rewritten".to_owned());
    }
    Ok(())
}

fn read_prefix(file: &mut File, size: u64, mut consume: impl FnMut(&[u8])) -> Result<(), String> {
    let mut remaining = size;
    let mut buffer = [0; 64 * 1024];
    let mut last = None;
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = file
            .read(&mut buffer[..limit])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("transcript prefix shrank".to_owned());
        }
        consume(&buffer[..count]);
        remaining -= count as u64;
        last = Some(buffer[count - 1]);
    }
    if size > 0 && last != Some(b'\n') {
        return Err("transcript prefix is not newline terminated".to_owned());
    }
    Ok(())
}

pub(crate) fn empty_transcript_history(window: TranscriptWindow) -> Result<Value, String> {
    serialize(HistoryParser::default(), window, None)
}

fn serialize(
    parser: HistoryParser,
    window: TranscriptWindow,
    fingerprint: Option<SessionFileFingerprint>,
) -> Result<Value, String> {
    serialize_windowed_projection(parser.finish(), window, fingerprint)
}

/// Reads the transcript for a snapshot through the shared session history
/// cache: an exact fingerprint match serves the window without parsing, a
/// smaller cached projection is extended by reading only its tail, and
/// anything else reads the requested prefix in full. The stored projection
/// follows the same one-entry-per-session rule as `load_history`, so later
/// page loads hit or extend it.
pub(crate) async fn read_transcript_history(
    path: String,
    base: Option<Arc<TranscriptBase>>,
    window: TranscriptWindow,
    history_cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project_id: &str,
) -> Result<Value, String> {
    let key = cache_key(project_id, &path);
    // Same order as load_history: the per-key load lock first; a cold slot is
    // only taken on a miss. Neither the turn lock nor the event publish lock
    // is held here.
    let load_lock = history_cache.lock().await.load_lock(&key);
    let _load_guard = load_lock.lock().await;

    let probe_base = base.clone();
    let probe_path = path.clone();
    let fingerprint = tokio::task::spawn_blocking(move || {
        probe_transcript(Path::new(&probe_path), probe_base.as_deref())
    })
    .await
    .map_err(|error| format!("transcript history task failed: {error}"))??;

    let cached = {
        let mut cache = history_cache.lock().await;
        cache
            .get_windowed(&key, fingerprint)
            .map(|(serialized, index)| (HistoryStorage::Memory(serialized), index))
            .or_else(|| {
                cache
                    .get_disk(&key, fingerprint)
                    .map(|(file, index)| (HistoryStorage::Disk(file), index))
            })
    };
    if let Some((storage, index)) = cached {
        let check_base = base.clone();
        let check_path = path.clone();
        let state = tokio::task::spawn_blocking(move || {
            probe_transcript(Path::new(&check_path), check_base.as_deref())
        })
        .await
        .map_err(|error| format!("transcript history task failed: {error}"))??;
        if state != fingerprint {
            return Err("transcript changed during read".to_owned());
        }
        return serve_transcript_window(storage, index, window, fingerprint).await;
    }

    let permit = super::reader::acquire_cold_load().await?;
    let incremental = history_cache
        .lock()
        .await
        .incremental_base(&key)
        .filter(|(_, _, cached)| cached.file_size < fingerprint.file_size);

    let mut loaded = None;
    if let Some((previous, previous_index, _)) = incremental {
        let read_base = base.clone();
        let read_path = path.clone();
        let read_permit = Arc::clone(&permit);
        loaded = match tokio::task::spawn_blocking(move || {
            let _task_permit = Arc::clone(&read_permit);
            extend_local_projection(
                Path::new(&read_path),
                read_base.as_deref(),
                &previous,
                &previous_index,
                &read_permit,
            )
        })
        .await
        .map_err(|error| format!("transcript history task failed: {error}"))?
        {
            Ok(loaded) => Some(loaded),
            Err(reason) => {
                log::debug!(target: "session-history", "transcript snapshot fell back to a full prefix read: {reason}");
                None
            }
        };
    }

    let (storage, index, fingerprint) = match loaded {
        Some(loaded) => loaded,
        None => {
            let read_base = base.clone();
            let read_path = path.clone();
            let read_permit = Arc::clone(&permit);
            let (history, fingerprint) = tokio::task::spawn_blocking(move || {
                let _permit = read_permit;
                read_local_projection(Path::new(&read_path), read_base.as_deref())
            })
            .await
            .map_err(|error| format!("transcript history task failed: {error}"))??;
            let serialize_permit = Arc::clone(&permit);
            let (serialized, index) = tokio::task::spawn_blocking(move || {
                let _permit = serialize_permit;
                serialize_windowed_history(history)
            })
            .await
            .map_err(|error| format!("transcript history task failed: {error}"))??;
            (HistoryStorage::Memory(serialized), index, fingerprint)
        }
    };

    let (storage, index, _) = super::reader::store_loaded_history(
        history_cache,
        key,
        fingerprint,
        storage,
        index,
        &permit,
    )
    .await?;
    serve_transcript_window(storage, index, window, fingerprint).await
}

pub(super) async fn serve_transcript_window(
    storage: HistoryStorage,
    index: Arc<SessionHistoryWindowIndex>,
    window: TranscriptWindow,
    fingerprint: SessionFileFingerprint,
) -> Result<Value, String> {
    let bytes = match window.message_limit {
        Some(limit) => {
            super::reader::respond_with_window(
                storage,
                index,
                window.start_message,
                limit,
                window.include_message_index,
                Some(fingerprint),
            )
            .await?
        }
        None => super::reader::respond_with_history(storage, Some(fingerprint)).await?,
    };
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("transcript history serialization failed: {error}"))
}

/// Opens the transcript and validates the recorded boundary without reading
/// the prefix, returning the fingerprint a projection of it carries.
fn probe_transcript(
    path: &Path,
    base: Option<&TranscriptBase>,
) -> Result<SessionFileFingerprint, String> {
    let mut file =
        File::open(path).map_err(|error| format!("transcript history open failed: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if !before.is_file() {
        return Err("transcript source is not a regular file".to_owned());
    }
    let size = base.map_or(before.len(), |base| base.size);
    if let Some(base) = base {
        validate_base(&mut file, &before, base)?;
    }
    transcript_fingerprint(&before, base, size)
}

fn transcript_fingerprint(
    before: &Metadata,
    base: Option<&TranscriptBase>,
    size: u64,
) -> Result<SessionFileFingerprint, String> {
    let mtime = base
        .map_or(before, |base| &base.metadata)
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(SessionFileFingerprint {
        file_size: size,
        file_mtime_ns: u64::try_from(mtime).map_err(|error| error.to_string())?,
    })
}

/// Reads the transcript tail after a cached checkpoint and splices the resumed
/// projection onto the cached one. Any error makes the caller read the prefix
/// in full instead.
fn extend_local_projection(
    path: &Path,
    base: Option<&TranscriptBase>,
    previous: &HistoryStorage,
    previous_index: &Arc<SessionHistoryWindowIndex>,
    permit: &Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<
    (
        HistoryStorage,
        Arc<SessionHistoryWindowIndex>,
        SessionFileFingerprint,
    ),
    String,
> {
    let state = previous_index
        .incremental
        .clone()
        .ok_or_else(|| "cached history has no checkpoint".to_owned())?;
    if !state.resumable() {
        return Err(format!("{} incremental updates reached", state.updates));
    }
    let start = state.checkpoint.file_offset;
    let image_locations = state.prefix_image_locations(&previous_index.image_locations);
    let mut file =
        File::open(path).map_err(|error| format!("transcript history open failed: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if !before.is_file() {
        return Err("transcript source is not a regular file".to_owned());
    }
    let size = base.map_or(before.len(), |base| base.size);
    if let Some(base) = base {
        validate_base(&mut file, &before, base)?;
    }
    if size <= start {
        return Err("transcript boundary is not past the cached checkpoint".to_owned());
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut parser = HistoryParser::resume(state, image_locations, Some(Arc::clone(permit)));
    read_prefix(&mut file, size - start, |bytes| parser.push(bytes))?;
    check_transcript_state(path, &mut file, &before, size, base)?;
    let fingerprint = transcript_fingerprint(&before, base, size)?;
    let prefer_disk = !SessionHistoryCache::fits_memory(fingerprint);
    let history = parser
        .finish_resumed()
        .ok_or_else(|| "transcript tail changed or the branch left the checkpoint".to_owned())?;
    let (storage, index) = extend_projection(previous, previous_index, history, prefer_disk)?;
    Ok((storage, index, fingerprint))
}

/// The same after-read consistency checks as a full prefix read: the file must
/// still be the same inode, must not have shrunk, and a boundary base must
/// still validate.
fn check_transcript_state(
    path: &Path,
    file: &mut File,
    before: &Metadata,
    size: u64,
    base: Option<&TranscriptBase>,
) -> Result<(), String> {
    let after = file.metadata().map_err(|error| error.to_string())?;
    let current = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !same_file(before, &current)
        || after.len() < size
        || current.len() < size
        || after.len() < before.len()
        || current.len() < after.len()
        || (before.len() == after.len() && before.modified().ok() != after.modified().ok())
        || (after.len() == current.len() && after.modified().ok() != current.modified().ok())
        || (base.is_none() && (before.len() != after.len() || after.len() != current.len()))
    {
        return Err("transcript changed during read".to_owned());
    }
    if let Some(base) = base {
        validate_base(file, &current, base)?;
    }
    Ok(())
}

pub(super) fn serialize_windowed_projection(
    history: super::types::SessionHistory,
    window: TranscriptWindow,
    fingerprint: Option<SessionFileFingerprint>,
) -> Result<Value, String> {
    let (history, index) = serialize_windowed_history(history)?;
    serialize_projection_window(&history, &index, window, fingerprint)
}

pub(super) fn serialize_projection_window(
    history: &[u8],
    index: &super::cache::SessionHistoryWindowIndex,
    window: TranscriptWindow,
    fingerprint: Option<SessionFileFingerprint>,
) -> Result<Value, String> {
    let bytes = match window.message_limit {
        Some(limit) => serialize_history_window_response(
            history,
            index,
            window.start_message,
            limit,
            window.include_message_index,
            fingerprint,
        ),
        None => serialize_history_response(history, fingerprint),
    };
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("transcript history serialization failed: {error}"))
}

pub(super) fn read_local_projection(
    path: &Path,
    base: Option<&TranscriptBase>,
) -> Result<(super::types::SessionHistory, SessionFileFingerprint), String> {
    let mut file =
        File::open(path).map_err(|error| format!("transcript history open failed: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if !before.is_file() {
        return Err("transcript source is not a regular file".to_owned());
    }
    let size = base.map_or(before.len(), |base| base.size);
    if let Some(base) = base {
        validate_base(&mut file, &before, base)?;
        file.rewind().map_err(|error| error.to_string())?;
    }
    let mut parser = HistoryParser::default();
    read_prefix(&mut file, size, |bytes| parser.push(bytes))?;
    check_transcript_state(path, &mut file, &before, size, base)?;
    let fingerprint = transcript_fingerprint(&before, base, size)?;
    Ok((parser.finish(), fingerprint))
}

#[cfg(test)]
#[path = "transcript_benchmark.rs"]
mod benchmark;

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    struct CountedReader {
        source: Cursor<Vec<u8>>,
        read: usize,
    }

    impl Read for CountedReader {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let count = self.source.read(bytes)?;
            self.read += count;
            Ok(count)
        }
    }

    impl Seek for CountedReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.source.seek(position)
        }
    }

    fn cached_fixture() -> (
        std::path::PathBuf,
        Arc<tokio::sync::Mutex<SessionHistoryCache>>,
    ) {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let name = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!(
            "pilo-transcript-cache-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        (
            directory,
            Arc::new(tokio::sync::Mutex::new(SessionHistoryCache::default())),
        )
    }

    fn entry(directory: &std::path::Path, name: &str, lines: &[serde_json::Value]) -> String {
        let path = directory.join(name);
        let mut bytes = String::new();
        for line in lines {
            bytes.push_str(&line.to_string());
            bytes.push('\n');
        }
        std::fs::write(&path, bytes).unwrap();
        path.to_str().unwrap().to_owned()
    }

    fn header(id: &str) -> serde_json::Value {
        serde_json::json!({"type":"session","version":3,"id":id,"timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"})
    }

    fn message(id: &str, parent: Option<&str>, role: &str, text: &str) -> serde_json::Value {
        serde_json::json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":role,"content":[{"type":"text","text":text}]}})
    }

    fn fingerprint_of(history: &Value) -> (u64, u64) {
        (
            history["fingerprint"]["fileSize"].as_u64().unwrap(),
            history["fingerprint"]["fileMtimeNs"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn snapshot_read_serves_a_matching_cached_projection() {
        let (directory, cache) = cached_fixture();
        let path = entry(
            &directory,
            "session.jsonl",
            &[
                header("s1"),
                message("u1", None, "user", "question"),
                message("a1", Some("u1"), "assistant", "answer"),
            ],
        );
        let key = cache_key("project", &path);
        let first = read_transcript_history(
            path.clone(),
            None,
            TranscriptWindow::default(),
            &cache,
            "project",
        )
        .await
        .unwrap();
        let (size, mtime) = fingerprint_of(&first);
        assert_eq!(size, std::fs::metadata(&path).unwrap().len());
        let stored = cache
            .lock()
            .await
            .cached_projection_for_test(&key)
            .expect("snapshot read did not populate the history cache");
        assert_eq!((stored.0, stored.1), (size, mtime));

        // Poison the cached projection: a read that parses the file again
        // would return the real entries, so an empty result proves the cache
        // served the window.
        {
            let (serialized, index) = serialize_windowed_history(
                crate::runtime::session_history::parser::parse_history(b""),
            )
            .unwrap();
            cache
                .lock()
                .await
                .replace_cached_projection_for_test(&key, serialized, index);
        }
        let second = read_transcript_history(
            path.clone(),
            None,
            TranscriptWindow::default(),
            &cache,
            "project",
        )
        .await
        .unwrap();
        assert_eq!(fingerprint_of(&second), (size, mtime));
        assert!(second["history"]["events"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn snapshot_read_extends_a_smaller_cached_projection() {
        let (directory, cache) = cached_fixture();
        let path = entry(
            &directory,
            "session.jsonl",
            &[
                header("s1"),
                message("u1", None, "user", "question"),
                message("a1", Some("u1"), "assistant", "answer"),
            ],
        );
        let key = cache_key("project", &path);
        read_transcript_history(
            path.clone(),
            None,
            TranscriptWindow::default(),
            &cache,
            "project",
        )
        .await
        .unwrap();
        // The turn appends to the file; the recorded boundary moves forward.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        writeln!(file, "{}", message("u2", Some("a1"), "user", "more")).unwrap();
        writeln!(file, "{}", message("a2", Some("u2"), "assistant", "more")).unwrap();
        drop(file);
        let base = record_transcript_base(path.clone()).unwrap();

        let second = read_transcript_history(
            path.clone(),
            Some(base),
            TranscriptWindow::default(),
            cache.as_ref(),
            "project",
        )
        .await
        .unwrap();
        let (size, _) = fingerprint_of(&second);
        assert_eq!(size, std::fs::metadata(&path).unwrap().len());
        let stored = cache.lock().await.cached_projection_for_test(&key).unwrap();
        assert_eq!(stored.2, 1, "extension did not go through the checkpoint");
        assert_eq!(
            second["history"],
            crate::runtime::session_history::full_history_snapshot_for_test(
                &std::fs::read(&path).unwrap()
            )["history"]
        );
        // The grown boundary now serves from the cache.
        {
            let (serialized, index) = serialize_windowed_history(
                crate::runtime::session_history::parser::parse_history(b""),
            )
            .unwrap();
            cache
                .lock()
                .await
                .replace_cached_projection_for_test(&key, serialized, index);
        }
        let third = read_transcript_history(
            path.clone(),
            Some(record_transcript_base(path.clone()).unwrap()),
            TranscriptWindow::default(),
            cache.as_ref(),
            "project",
        )
        .await
        .unwrap();
        assert!(third["history"]["events"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn snapshot_read_stores_a_smaller_prefix_over_a_newer_projection() {
        let (directory, cache) = cached_fixture();
        let path = entry(
            &directory,
            "session.jsonl",
            &[
                header("s1"),
                message("u1", None, "user", "question"),
                message("a1", Some("u1"), "assistant", "answer"),
            ],
        );
        let key = cache_key("project", &path);
        // The turn's boundary is recorded, then the file keeps growing.
        let base = record_transcript_base(path.clone()).unwrap();
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            use std::io::Write;
            writeln!(file, "{}", message("u2", Some("a1"), "user", "more")).unwrap();
            writeln!(file, "{}", message("a2", Some("u2"), "assistant", "more")).unwrap();
        }
        // A read without a boundary stores the projection of the grown file.
        let grown = read_transcript_history(
            path.clone(),
            None,
            TranscriptWindow::default(),
            cache.as_ref(),
            "project",
        )
        .await
        .unwrap();
        let (grown_size, _) = fingerprint_of(&grown);

        // The snapshot of the earlier boundary replaces the newer projection
        // with the smaller prefix.
        let snapshot = read_transcript_history(
            path.clone(),
            Some(base),
            TranscriptWindow::default(),
            cache.as_ref(),
            "project",
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{error}; dir={:?}",
                std::fs::read_dir(&directory).map(|list| list
                    .filter_map(|entry| entry.ok().map(|e| e.file_name()))
                    .collect::<Vec<_>>())
            )
        });
        let (prefix_size, _) = fingerprint_of(&snapshot);
        assert!(prefix_size < grown_size);
        let stored = cache.lock().await.cached_projection_for_test(&key).unwrap();
        assert_eq!(stored.0, prefix_size);

        // A later read with no recorded boundary must still return the
        // current file: it extends the stored prefix back to the grown
        // content instead of serving stale data.
        let current = read_transcript_history(
            path.clone(),
            None,
            TranscriptWindow::default(),
            cache.as_ref(),
            "project",
        )
        .await
        .unwrap();
        assert_eq!(fingerprint_of(&current).0, grown_size);
        assert_eq!(
            current["history"],
            crate::runtime::session_history::full_history_snapshot_for_test(
                &std::fs::read(&path).unwrap()
            )["history"]
        );
        let stored = cache.lock().await.cached_projection_for_test(&key).unwrap();
        assert_eq!((stored.0, stored.2), (grown_size, 1));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn snapshot_reads_serialize_per_file_without_blocking_others() {
        let (directory, cache) = cached_fixture();
        let first = entry(
            &directory,
            "first.jsonl",
            &[header("s1"), message("u1", None, "user", "one")],
        );
        let second = entry(
            &directory,
            "second.jsonl",
            &[header("s2"), message("u1", None, "user", "two")],
        );
        let per_key = {
            let mut guard = cache.lock().await;
            guard.load_lock(&cache_key("project", &first))
        };
        let held = per_key.lock().await;
        let first_path = first.clone();
        let blocked_cache = Arc::clone(&cache);
        let blocked = tokio::spawn(async move {
            read_transcript_history(
                first_path,
                None,
                TranscriptWindow::default(),
                &blocked_cache,
                "project",
            )
            .await
        });
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!blocked.is_finished());
        let other = read_transcript_history(
            second,
            None,
            TranscriptWindow::default(),
            cache.as_ref(),
            "project",
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{error}; dir={:?}",
                std::fs::read_dir(&directory).map(|list| list
                    .filter_map(|entry| entry.ok().map(|e| e.file_name()))
                    .collect::<Vec<_>>())
            )
        });
        assert!(!other["history"]["events"].as_array().unwrap().is_empty());
        assert!(!blocked.is_finished());
        drop(held);
        assert!(blocked.await.unwrap().is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn capture_tail_reads_at_most_64_kib_and_uses_the_recorded_boundary() {
        for size in [0, 4096, TAIL_BYTES, TAIL_BYTES * 4] {
            let mut bytes = vec![b'x'; size + 7];
            if size > 0 {
                bytes[size - 1] = b'\n';
            }
            let expected: [u8; 32] =
                Sha256::digest(&bytes[size.saturating_sub(TAIL_BYTES)..size]).into();
            let mut reader = CountedReader {
                source: Cursor::new(bytes),
                read: 0,
            };
            assert_eq!(read_tail(&mut reader, size as u64).unwrap(), expected);
            assert_eq!(reader.read, size.min(TAIL_BYTES));
            assert_eq!(reader.source.position(), size as u64);
        }
    }
}
