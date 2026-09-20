use std::{
    collections::{HashMap, VecDeque},
    ops::Range,
    sync::Arc,
};

use serde_json::Value;

use crate::domain::Project;

use super::types::ImageLocation;

pub(super) const SESSION_HISTORY_CACHE_CAPACITY: usize = 8;
pub(super) const SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES: usize = 128 * 1024 * 1024;
const SESSION_HISTORY_CACHE_ESTIMATE_MULTIPLIER: usize = 2;
const IMAGE_LOCATION_CACHE_CAPACITY: usize = 16;

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
    pub(super) image_locations: ImageLocations,
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

#[derive(Default)]
pub(crate) struct SessionHistoryCache {
    pub(super) entries: HashMap<String, CachedSessionHistory>,
    order: VecDeque<String>,
    estimated_bytes: usize,
    image_location_entries: HashMap<String, CachedImageLocations>,
    image_location_order: VecDeque<String>,
}

impl SessionHistoryCache {
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
        self.remove(&key);
        let estimated_bytes = estimated_history_bytes(fingerprint);
        if estimated_bytes > SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES {
            return;
        }
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
        let key = cache_key(project, path);
        self.remove(&key);
        self.remove_image_locations(&key);
    }

    fn remove(&mut self, key: &str) {
        self.remove_entry(key);
        self.order.retain(|candidate| candidate != key);
    }
}

fn estimated_history_bytes(fingerprint: SessionFileFingerprint) -> usize {
    usize::try_from(fingerprint.file_size)
        .unwrap_or(usize::MAX)
        .saturating_mul(SESSION_HISTORY_CACHE_ESTIMATE_MULTIPLIER)
}

pub(super) fn cache_key(project: &Project, path: &str) -> String {
    format!("{}\0{path}", project.id)
}

pub(super) fn fingerprint_from_metadata(metadata: &Value) -> Option<SessionFileFingerprint> {
    Some(SessionFileFingerprint {
        file_size: metadata.get("fileSize")?.as_u64()?,
        file_mtime_ns: metadata.get("fileMtimeNs")?.as_u64()?,
    })
}
