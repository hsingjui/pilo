use std::{
    collections::{HashMap, VecDeque},
    ops::Range,
    sync::{Arc, Weak},
};

use serde_json::Value;

use crate::domain::Project;

use super::{disk::DiskHistory, incremental::IncrementalState, types::ImageLocation};

pub(super) const SESSION_HISTORY_CACHE_CAPACITY: usize = 16;
// Resident budget for parsed histories. Larger sessions use the disk cache,
// which serves the same windows without keeping the whole history in RAM.
pub(super) const SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES: usize = 64 * 1024 * 1024;
const SESSION_HISTORY_CACHE_ESTIMATE_MULTIPLIER: usize = 2;
const IMAGE_LOCATION_CACHE_CAPACITY: usize = 16;
const SESSION_HISTORY_DISK_CACHE_MAX_BYTES: usize = 2 * 1024 * 1024 * 1024;
const SESSION_HISTORY_DISK_INDEX_MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SessionFileFingerprint {
    pub(super) file_size: u64,
    pub(super) file_mtime_ns: u64,
}

pub(super) type ImageLocations = Arc<HashMap<String, ImageLocation>>;

#[derive(Clone, Debug)]
pub(super) struct SessionHistoryWindowIndex {
    pub(super) events_content_start: usize,
    pub(super) events_content_end: usize,
    pub(super) message_ranges: Vec<Range<usize>>,
    pub(super) message_index_json: Arc<Vec<u8>>,
    /// Byte range of each entry in `message_index_json`.
    pub(super) directory_ranges: Vec<Range<usize>>,
    pub(super) image_locations: ImageLocations,
    pub(super) incremental: Option<IncrementalState>,
}

pub(super) enum HistoryStorage {
    Memory(Arc<Vec<u8>>),
    Disk(Arc<DiskHistory>),
}

#[derive(Clone)]
pub(super) struct CachedSessionHistory {
    fingerprint: SessionFileFingerprint,
    serialized_json: Arc<Vec<u8>>,
    window_index: Option<Arc<SessionHistoryWindowIndex>>,
    estimated_bytes: usize,
}

#[derive(Clone)]
struct CachedImageLocations {
    fingerprint: SessionFileFingerprint,
    locations: ImageLocations,
}

#[derive(Clone)]
struct CachedDiskHistory {
    fingerprint: SessionFileFingerprint,
    file: Arc<DiskHistory>,
    index: Arc<SessionHistoryWindowIndex>,
    index_bytes: usize,
}

#[derive(Default)]
pub(crate) struct SessionHistoryCache {
    pub(super) entries: HashMap<String, CachedSessionHistory>,
    order: VecDeque<String>,
    estimated_bytes: usize,
    image_location_entries: HashMap<String, CachedImageLocations>,
    image_location_order: VecDeque<String>,
    disk_entries: HashMap<String, CachedDiskHistory>,
    disk_order: VecDeque<String>,
    disk_bytes: usize,
    disk_index_bytes: usize,
    load_locks: HashMap<String, Weak<tokio::sync::Mutex<()>>>,
}

impl SessionHistoryCache {
    pub(super) fn load_lock(&mut self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.load_locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = self.load_locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        self.load_locks
            .insert(key.to_owned(), Arc::downgrade(&lock));
        lock
    }

    pub(super) fn fits_memory(fingerprint: SessionFileFingerprint) -> bool {
        estimated_history_bytes(fingerprint) <= SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES
    }

    pub(super) fn has_history(&self, key: &str) -> bool {
        self.entries.contains_key(key) || self.disk_entries.contains_key(key)
    }

    /// A cached projection of any fingerprint that can be extended from its
    /// checkpoint. It stays cached until a replacement is inserted.
    pub(super) fn incremental_base(
        &self,
        key: &str,
    ) -> Option<(
        HistoryStorage,
        Arc<SessionHistoryWindowIndex>,
        SessionFileFingerprint,
    )> {
        if let Some(entry) = self.entries.get(key)
            && let Some(index) = entry
                .window_index
                .as_ref()
                .filter(|index| index.incremental.is_some())
        {
            return Some((
                HistoryStorage::Memory(Arc::clone(&entry.serialized_json)),
                Arc::clone(index),
                entry.fingerprint,
            ));
        }
        self.disk_entries
            .get(key)
            .filter(|entry| entry.index.incremental.is_some())
            .map(|entry| {
                (
                    HistoryStorage::Disk(Arc::clone(&entry.file)),
                    Arc::clone(&entry.index),
                    entry.fingerprint,
                )
            })
    }

    pub(super) fn fits_disk(bytes: usize, index: &SessionHistoryWindowIndex) -> bool {
        bytes <= SESSION_HISTORY_DISK_CACHE_MAX_BYTES
            && estimated_index_bytes(index) <= SESSION_HISTORY_DISK_INDEX_MAX_BYTES
    }

    pub(super) fn get_disk(
        &mut self,
        key: &str,
        fingerprint: SessionFileFingerprint,
    ) -> Option<(Arc<DiskHistory>, Arc<SessionHistoryWindowIndex>)> {
        let entry = self
            .disk_entries
            .get(key)
            .filter(|entry| entry.fingerprint == fingerprint)?;
        let result = (Arc::clone(&entry.file), Arc::clone(&entry.index));
        self.disk_order.retain(|candidate| candidate != key);
        self.disk_order.push_back(key.to_owned());
        Some(result)
    }

    pub(super) fn insert_disk(
        &mut self,
        key: String,
        fingerprint: SessionFileFingerprint,
        file: Arc<DiskHistory>,
        index: Arc<SessionHistoryWindowIndex>,
    ) {
        let index_bytes = estimated_index_bytes(&index);
        if !Self::fits_disk(file.bytes, &index) {
            return;
        }
        self.remove(&key);
        self.disk_bytes = self.disk_bytes.saturating_add(file.bytes);
        self.disk_index_bytes = self.disk_index_bytes.saturating_add(index_bytes);
        self.disk_order.push_back(key.clone());
        self.disk_entries.insert(
            key,
            CachedDiskHistory {
                fingerprint,
                file,
                index,
                index_bytes,
            },
        );
        while self.disk_order.len() > SESSION_HISTORY_CACHE_CAPACITY
            || self.disk_bytes > SESSION_HISTORY_DISK_CACHE_MAX_BYTES
            || self.disk_index_bytes > SESSION_HISTORY_DISK_INDEX_MAX_BYTES
        {
            let Some(key) = self.disk_order.front().cloned() else {
                break;
            };
            self.remove_disk(&key);
        }
    }

    fn remove_disk(&mut self, key: &str) {
        if let Some(entry) = self.disk_entries.remove(key) {
            self.disk_bytes = self.disk_bytes.saturating_sub(entry.file.bytes);
            self.disk_index_bytes = self.disk_index_bytes.saturating_sub(entry.index_bytes);
        }
        self.disk_order.retain(|candidate| candidate != key);
    }

    #[cfg(test)]
    pub(super) fn get_serialized(
        &mut self,
        key: &str,
        fingerprint: SessionFileFingerprint,
    ) -> Option<Arc<Vec<u8>>> {
        let serialized = match self.entries.get(key) {
            Some(entry) if entry.fingerprint == fingerprint => Arc::clone(&entry.serialized_json),
            Some(_) => return None,
            None => return None,
        };
        self.touch(key);
        Some(serialized)
    }

    pub(super) fn get_windowed(
        &mut self,
        key: &str,
        fingerprint: SessionFileFingerprint,
    ) -> Option<(Arc<Vec<u8>>, Arc<SessionHistoryWindowIndex>)> {
        let (serialized, index) = match self.entries.get(key) {
            Some(entry) if entry.fingerprint == fingerprint => (
                Arc::clone(&entry.serialized_json),
                Arc::clone(entry.window_index.as_ref()?),
            ),
            Some(_) => return None,
            None => return None,
        };
        self.touch(key);
        Some((serialized, index))
    }

    #[cfg(test)]
    pub(super) fn insert_serialized(
        &mut self,
        key: String,
        fingerprint: SessionFileFingerprint,
        serialized_json: Arc<Vec<u8>>,
    ) {
        self.insert_entry(key, fingerprint, serialized_json, None);
    }

    pub(super) fn insert_windowed(
        &mut self,
        key: String,
        fingerprint: SessionFileFingerprint,
        serialized_json: Arc<Vec<u8>>,
        window_index: Arc<SessionHistoryWindowIndex>,
    ) {
        self.insert_entry(key, fingerprint, serialized_json, Some(window_index));
    }

    fn insert_entry(
        &mut self,
        key: String,
        fingerprint: SessionFileFingerprint,
        serialized_json: Arc<Vec<u8>>,
        window_index: Option<Arc<SessionHistoryWindowIndex>>,
    ) {
        let estimated_bytes = estimated_history_bytes(fingerprint);
        if estimated_bytes > SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES {
            return;
        }
        self.remove(&key);
        self.entries.insert(
            key.clone(),
            CachedSessionHistory {
                fingerprint,
                serialized_json,
                window_index,
                estimated_bytes,
            },
        );
        self.estimated_bytes = self.estimated_bytes.saturating_add(estimated_bytes);
        self.order.push_back(key);
        while self.order.len() > SESSION_HISTORY_CACHE_CAPACITY
            || self.estimated_bytes > SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES
        {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            self.remove_entry(&evicted);
        }
    }

    /// Small dedicated LRU for image line indexes. Files whose full serialized
    /// history exceeds the byte budget (multi-image sessions grow fast) still
    /// get cheap lazy image reads instead of reparsing the whole JSONL.
    pub(super) fn get_image_locations(
        &mut self,
        key: &str,
        fingerprint: SessionFileFingerprint,
    ) -> Option<ImageLocations> {
        if let Some(entry) = self
            .disk_entries
            .get(key)
            .filter(|entry| entry.fingerprint == fingerprint)
        {
            return Some(Arc::clone(&entry.index.image_locations));
        }
        let locations = match self.image_location_entries.get(key) {
            Some(entry) if entry.fingerprint == fingerprint => Arc::clone(&entry.locations),
            Some(_) => return None,
            None => return None,
        };
        self.touch_image_locations(key);
        Some(locations)
    }

    pub(super) fn insert_image_locations(
        &mut self,
        key: String,
        fingerprint: SessionFileFingerprint,
        locations: ImageLocations,
    ) {
        if locations.is_empty() {
            return;
        }
        self.remove_image_locations(&key);
        self.image_location_entries.insert(
            key.clone(),
            CachedImageLocations {
                fingerprint,
                locations,
            },
        );
        self.image_location_order.push_back(key);
        while self.image_location_order.len() > IMAGE_LOCATION_CACHE_CAPACITY {
            let Some(evicted) = self.image_location_order.pop_front() else {
                break;
            };
            self.remove_image_locations(&evicted);
        }
    }

    fn touch_image_locations(&mut self, key: &str) {
        self.image_location_order
            .retain(|candidate| candidate != key);
        self.image_location_order.push_back(key.to_owned());
    }

    fn remove_image_locations(&mut self, key: &str) {
        self.image_location_entries.remove(key);
        self.image_location_order
            .retain(|candidate| candidate != key);
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.to_owned());
    }

    fn remove_entry(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.estimated_bytes = self.estimated_bytes.saturating_sub(entry.estimated_bytes);
        }
    }

    pub(crate) fn invalidate(&mut self, project: &Project, path: &str) {
        let key = cache_key(&project.id, path);
        self.remove(&key);
        self.remove_image_locations(&key);
    }

    fn remove(&mut self, key: &str) {
        self.remove_disk(key);
        self.remove_entry(key);
        self.order.retain(|candidate| candidate != key);
    }
}

fn estimated_index_bytes(index: &SessionHistoryWindowIndex) -> usize {
    index
        .message_index_json
        .capacity()
        .saturating_add(
            index
                .message_ranges
                .capacity()
                .saturating_mul(std::mem::size_of::<Range<usize>>()),
        )
        .saturating_add(
            index
                .directory_ranges
                .capacity()
                .saturating_mul(std::mem::size_of::<Range<usize>>()),
        )
        .saturating_add(index.incremental.as_ref().map_or(0, |state| {
            std::mem::size_of::<IncrementalState>()
                .saturating_add(state.checkpoint.entry_id.capacity())
        }))
        .saturating_add(
            index
                .image_locations
                .capacity()
                .saturating_mul(std::mem::size_of::<(String, ImageLocation)>() + 1),
        )
        .saturating_add(
            index
                .image_locations
                .keys()
                .map(String::capacity)
                .fold(0_usize, usize::saturating_add),
        )
}

fn estimated_history_bytes(fingerprint: SessionFileFingerprint) -> usize {
    usize::try_from(fingerprint.file_size)
        .unwrap_or(usize::MAX)
        .saturating_mul(SESSION_HISTORY_CACHE_ESTIMATE_MULTIPLIER)
}

pub(super) fn cache_key(project_id: &str, path: &str) -> String {
    format!("{project_id}\0{path}")
}

pub(super) fn fingerprint_from_metadata(metadata: &Value) -> Option<SessionFileFingerprint> {
    Some(SessionFileFingerprint {
        file_size: metadata.get("fileSize")?.as_u64()?,
        file_mtime_ns: metadata.get("fileMtimeNs")?.as_u64()?,
    })
}
