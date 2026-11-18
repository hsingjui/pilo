use std::{collections::HashMap, sync::Arc};

use sha2::{Digest, Sha256};

use super::cache::{HistoryStorage, SessionHistoryCache, SessionHistoryWindowIndex};
use super::disk::DiskHistory;
use super::serialize::{HistoryPrefix, serialize_history_tail};
use super::types::{ImageLocation, SessionHistory, SessionHistoryModel, SessionHistoryStats};

/// A cached projection is rebuilt from the source after this many incremental
/// updates, bounding drift from edits the checkpoint digest cannot see.
pub(super) const MAX_INCREMENTAL_UPDATES: u32 = 64;

/// SHA-256 state after hashing the source from offset 0 to a line boundary.
/// Continuing it over later bytes verifies those bytes without rereading the prefix.
#[derive(Clone, Default)]
pub(super) struct HashState(Sha256);

impl HashState {
    pub(super) fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub(super) fn digest(&self) -> [u8; 32] {
        self.0.clone().finalize().into()
    }
}

impl PartialEq for HashState {
    fn eq(&self, other: &Self) -> bool {
        self.digest() == other.digest()
    }
}

impl std::fmt::Debug for HashState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("HashState")
    }
}

/// Branch metadata carried across the projection; the turn state is always
/// empty at a checkpoint because user messages and compactions close turns.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ProjectionState {
    pub(super) model: Option<SessionHistoryModel>,
    pub(super) thinking_level: Option<String>,
    pub(super) name: Option<String>,
    pub(super) source_message_count: usize,
}

/// The last user message or compaction on the active branch. Projected messages
/// before it never change while it stays on the branch, so later loads reread the
/// source from its line and reproject only the tail.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HistoryCheckpoint {
    pub(super) entry_id: String,
    /// Line start in the source, before any BOM.
    pub(super) file_offset: u64,
    /// Index of the split message the checkpoint starts.
    pub(super) message_index: usize,
    /// Source hash state at `file_offset`.
    pub(super) hash_state: HashState,
    /// Branch state before the checkpoint entry.
    pub(super) state: ProjectionState,
    /// Stats over every source entry before `file_offset`; `context_tokens`
    /// holds the branch value before the checkpoint.
    pub(super) stats: SessionHistoryStats,
    pub(super) header_missing: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct IncrementalState {
    pub(super) checkpoint: HistoryCheckpoint,
    /// End of the last newline-terminated source line.
    pub(super) committed_offset: u64,
    /// Source hash state at `committed_offset`, finalized.
    pub(super) committed_digest: [u8; 32],
    pub(super) updates: u32,
}

impl IncrementalState {
    pub(super) fn resumable(&self) -> bool {
        self.updates < MAX_INCREMENTAL_UPDATES
    }

    /// Image locations a resumed parser keeps; the tail reindexes the rest.
    pub(super) fn prefix_image_locations(
        &self,
        locations: &HashMap<String, ImageLocation>,
    ) -> HashMap<String, ImageLocation> {
        locations
            .iter()
            .filter(|(_, location)| location.byte_offset < self.checkpoint.file_offset)
            .map(|(id, location)| (id.clone(), *location))
            .collect()
    }
}

/// Splices a resumed projection after the cached messages before its checkpoint.
/// With `prefer_disk`, a disk-cached projection is extended into a new disk file;
/// otherwise the result is held in memory.
pub(super) fn extend_projection(
    previous: &HistoryStorage,
    previous_index: &SessionHistoryWindowIndex,
    history: SessionHistory,
    prefer_disk: bool,
) -> Result<(HistoryStorage, Arc<SessionHistoryWindowIndex>), String> {
    let kept = history.first_message_index;
    let (Some(events), Some(directory)) = (
        previous_index.message_ranges.get(kept),
        previous_index.directory_ranges.get(kept),
    ) else {
        return Err("cached index has no checkpoint message".to_owned());
    };
    let prefix = HistoryPrefix {
        serialized_len: events.start,
        events_content_start: previous_index.events_content_start,
        message_ranges: &previous_index.message_ranges[..kept],
        directory: &previous_index.message_index_json[..directory.start],
        directory_ranges: &previous_index.directory_ranges[..kept],
    };

    if let (HistoryStorage::Disk(file), true) = (previous, prefer_disk) {
        let mut tail = Vec::new();
        let index = serialize_history_tail(history, &prefix, &mut tail, prefix.serialized_len)?;
        let index = Arc::new(index);
        if SessionHistoryCache::fits_disk(prefix.serialized_len + tail.len(), &index) {
            match DiskHistory::create_from_prefix(file, prefix.serialized_len, &tail) {
                Ok(file) => return Ok((HistoryStorage::Disk(Arc::new(file)), index)),
                Err(error) => log::warn!(target: "session-history", "{error}"),
            }
        }
        let mut serialized = file.read_prefix(prefix.serialized_len)?;
        serialized.extend_from_slice(&tail);
        return Ok((HistoryStorage::Memory(Arc::new(serialized)), index));
    }

    let mut serialized = match previous {
        HistoryStorage::Memory(bytes) => bytes[..prefix.serialized_len].to_vec(),
        HistoryStorage::Disk(file) => file.read_prefix(prefix.serialized_len)?,
    };
    let index = serialize_history_tail(history, &prefix, &mut serialized, 0)?;
    Ok((
        HistoryStorage::Memory(Arc::new(serialized)),
        Arc::new(index),
    ))
}
