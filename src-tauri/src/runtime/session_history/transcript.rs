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
    cache::SessionFileFingerprint,
    parser::HistoryParser,
    serialize::{
        serialize_history_response, serialize_history_window_response, serialize_windowed_history,
    },
};
use crate::runtime::transcript::TranscriptWindow;

const TAIL_BYTES: usize = 64 * 1024;

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

pub(crate) async fn read_transcript_history(
    path: String,
    base: Option<Arc<TranscriptBase>>,
    window: TranscriptWindow,
) -> Result<Value, String> {
    let permit = super::reader::acquire_cold_load().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read_local_history(Path::new(&path), base.as_deref(), window)
    })
    .await
    .map_err(|error| format!("transcript history task failed: {error}"))?
}

pub(super) fn read_local_history(
    path: &Path,
    base: Option<&TranscriptBase>,
    window: TranscriptWindow,
) -> Result<Value, String> {
    let (history, fingerprint) = read_local_projection(path, base)?;
    serialize_windowed_projection(history, window, Some(fingerprint))
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
    let after = file.metadata().map_err(|error| error.to_string())?;
    let current = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !same_file(&before, &current)
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
        validate_base(&mut file, &current, base)?;
    }
    let mtime = base
        .map_or(&before, |base| &base.metadata)
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let file_mtime_ns = u64::try_from(mtime).map_err(|error| error.to_string())?;
    Ok((
        parser.finish(),
        SessionFileFingerprint {
            file_size: size,
            file_mtime_ns,
        },
    ))
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
