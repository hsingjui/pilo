use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    ops::Range,
    sync::{Arc, Mutex},
};

use super::{
    cache::{SessionFileFingerprint, SessionHistoryWindowIndex},
    serialize::{history_window_range, serialize_history_response, serialize_history_window_parts},
};

/// Disposable projected history, never the source JSONL or an authoritative copy.
/// The anonymous file is removed when its last handle closes, including on crashes.
pub(super) struct DiskHistory {
    file: Mutex<File>,
    pub(super) bytes: usize,
}

impl DiskHistory {
    pub(super) fn create(serialized: &[u8]) -> Result<Self, String> {
        let mut file = create_cache_file()?;
        file.write_all(serialized)
            .map_err(|error| format!("failed to write history cache: {error}"))?;
        Ok(Self {
            file: Mutex::new(file),
            bytes: serialized.len(),
        })
    }

    /// Copies `prefix_len` bytes of a cached projection into a new disposable file,
    /// then appends `tail`. `previous` keeps serving its own readers.
    pub(super) fn create_from_prefix(
        previous: &DiskHistory,
        prefix_len: usize,
        tail: &[u8],
    ) -> Result<Self, String> {
        let mut file = create_cache_file()?;
        let mut source = previous
            .file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        source
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("failed to seek history cache: {error}"))?;
        let copied = std::io::copy(&mut (&mut *source).take(prefix_len as u64), &mut file)
            .map_err(|error| format!("failed to copy history cache: {error}"))?;
        drop(source);
        if copied != prefix_len as u64 {
            return Err("failed to copy history cache: cached prefix is truncated".to_owned());
        }
        file.write_all(tail)
            .map_err(|error| format!("failed to write history cache: {error}"))?;
        Ok(Self {
            file: Mutex::new(file),
            bytes: prefix_len + tail.len(),
        })
    }

    pub(super) fn read_prefix(&self, len: usize) -> Result<Vec<u8>, String> {
        let mut file = self
            .file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        read_range(&mut file, 0..len)
    }

    pub(super) fn read_full(
        &self,
        fingerprint: Option<SessionFileFingerprint>,
    ) -> Result<Vec<u8>, String> {
        let mut file = self
            .file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let history = read_range(&mut file, 0..self.bytes)?;
        drop(file);
        Ok(serialize_history_response(&history, fingerprint))
    }

    pub(super) async fn read_window(
        self: Arc<Self>,
        index: Arc<SessionHistoryWindowIndex>,
        start_message: Option<usize>,
        message_limit: usize,
        include_message_index: bool,
        fingerprint: Option<SessionFileFingerprint>,
    ) -> Result<Vec<u8>, String> {
        tokio::task::spawn_blocking(move || {
            let window =
                history_window_range(index.message_ranges.len(), start_message, message_limit);
            let mut file = self
                .file
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let prefix = read_range(&mut file, 0..index.events_content_start)?;
            let suffix = read_range(&mut file, index.events_content_end..self.bytes - 1)?;
            let events = if window.is_empty() {
                Vec::new()
            } else {
                read_range(
                    &mut file,
                    index.message_ranges[window.start].start
                        ..index.message_ranges[window.end - 1].end,
                )?
            };
            drop(file);
            Ok(serialize_history_window_parts(
                &prefix,
                &events,
                &suffix,
                &index,
                window,
                include_message_index,
                fingerprint,
            ))
        })
        .await
        .map_err(|error| format!("history cache read task failed: {error}"))?
    }
}

fn create_cache_file() -> Result<File, String> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|error| format!("failed to name history cache: {error}"))?;
    let name = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = std::env::temp_dir().join(format!("pilo-history-{}-{name}", std::process::id()));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::FILE_FLAG_DELETE_ON_CLOSE;
        options.custom_flags(FILE_FLAG_DELETE_ON_CLOSE.0);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("failed to create history cache: {error}"))?;
    #[cfg(not(windows))]
    std::fs::remove_file(&path)
        .map_err(|error| format!("failed to unlink history cache: {error}"))?;
    Ok(file)
}

fn read_range(file: &mut File, range: Range<usize>) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(range.start as u64))
        .map_err(|error| format!("failed to seek history cache: {error}"))?;
    let mut bytes = vec![0; range.len()];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("failed to read history cache: {error}"))?;
    Ok(bytes)
}
