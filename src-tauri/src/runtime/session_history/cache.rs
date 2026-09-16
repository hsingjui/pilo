use std::{
    collections::{HashMap, VecDeque},
    ops::Range,
    sync::Arc,
};

use serde_json::Value;

use crate::domain::Project;

pub(super) const SESSION_HISTORY_CACHE_CAPACITY: usize = 8;
pub(super) const SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES: usize = 128 * 1024 * 1024;
const SESSION_HISTORY_CACHE_ESTIMATE_MULTIPLIER: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SessionFileFingerprint {
    pub(super) file_size: u64,
    pub(super) file_mtime_ns: u64,
}

#[derive(Clone, Debug)]
pub(super) struct SessionHistoryWindowIndex {
    pub(super) events_content_start: usize,
    pub(super) events_content_end: usize,
    pub(super) message_ranges: Vec<Range<usize>>,
    pub(super) message_index_json: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub(super) struct CachedSessionHistory {
    fingerprint: SessionFileFingerprint,
    serialized_json: Arc<Vec<u8>>,
    window_index: Option<Arc<SessionHistoryWindowIndex>>,
    estimated_bytes: usize,
}

#[derive(Default)]
pub(crate) struct SessionHistoryCache {
    pub(super) entries: HashMap<String, CachedSessionHistory>,
    order: VecDeque<String>,
    estimated_bytes: usize,
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
        self.remove(&cache_key(project, path));
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
