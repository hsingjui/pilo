use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::incremental::{HashState, HistoryCheckpoint, IncrementalState};
use super::parser_fields::record_image_locations;
use super::parser_projection::project_branch;
use super::parser_stats::{accumulate_history_stats, branch_context_tokens};
use super::types::{ImageLocation, SessionHistory, SessionHistoryStats};

#[derive(Default)]
pub(super) struct HistoryParser {
    entries: Vec<Value>,
    /// Source line start of each entry, before any BOM.
    entry_offsets: Vec<u64>,
    /// Hash state at the start of each complete checkpoint-candidate line, by entry index.
    checkpoint_hashes: HashMap<usize, HashState>,
    _load_permit: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
    partial_line: Vec<u8>,
    partial_line_offset: u64,
    consumed_bytes: u64,
    /// Covers newline-terminated lines only, so it always ends at `committed_offset`.
    hash: HashState,
    committed_offset: u64,
    image_locations: HashMap<String, ImageLocation>,
    resume: Option<IncrementalState>,
    /// Whether resumed bytes reproduced the cached digest at its committed offset.
    verified: Option<bool>,
}

impl HistoryParser {
    pub(super) fn with_load_permit(
        permit: std::sync::Arc<tokio::sync::OwnedSemaphorePermit>,
    ) -> Self {
        Self {
            _load_permit: Some(permit),
            ..Self::default()
        }
    }

    /// Continues a cached projection. Feed source bytes from the checkpoint offset;
    /// `image_locations` holds only locations before that offset.
    pub(super) fn resume(
        state: IncrementalState,
        image_locations: HashMap<String, ImageLocation>,
        permit: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
    ) -> Self {
        let offset = state.checkpoint.file_offset;
        Self {
            consumed_bytes: offset,
            committed_offset: offset,
            hash: state.checkpoint.hash_state.clone(),
            image_locations,
            resume: Some(state),
            _load_permit: permit,
            ..Self::default()
        }
    }

    /// The resumed source no longer matches the cached bytes; stop reading.
    pub(super) fn verification_failed(&self) -> bool {
        self.verified == Some(false)
    }

    pub(super) fn push(&mut self, mut bytes: &[u8]) {
        let total_bytes = bytes.len() as u64;
        let mut absolute = self.consumed_bytes;
        if !self.partial_line.is_empty() {
            let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') else {
                self.partial_line.extend_from_slice(bytes);
                self.consumed_bytes += total_bytes;
                return;
            };
            self.partial_line.extend_from_slice(&bytes[..newline]);
            let line = std::mem::take(&mut self.partial_line);
            self.push_line(&line, self.partial_line_offset, true);
            bytes = &bytes[newline + 1..];
            absolute += (newline + 1) as u64;
        }

        let mut start = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            self.push_line(&bytes[start..index], absolute + start as u64, true);
            start = index + 1;
        }
        if start < bytes.len() {
            if self.partial_line.is_empty() {
                self.partial_line_offset = absolute + start as u64;
            }
            self.partial_line.extend_from_slice(&bytes[start..]);
        }
        self.consumed_bytes += total_bytes;
    }

    /// Projects a source read from offset 0.
    pub(super) fn finish(self) -> SessionHistory {
        debug_assert!(self.resume.is_none(), "resumed parsers use finish_resumed");
        self.finish_projection().unwrap_or_default()
    }

    /// Projects a resumed tail. `None` means the cached projection cannot be
    /// extended and the source needs a full read.
    pub(super) fn finish_resumed(self) -> Option<SessionHistory> {
        self.finish_projection()
    }

    fn push_line(&mut self, line: &[u8], line_offset: u64, complete: bool) {
        if let Some(entry) = parse_entry(line, line_offset, &mut self.image_locations) {
            // A line may still be growing until its newline arrives, so only
            // complete lines can anchor a later resume.
            if complete && is_checkpoint_candidate(&entry) {
                self.checkpoint_hashes
                    .insert(self.entries.len(), self.hash.clone());
            }
            self.entries.push(entry);
            self.entry_offsets.push(line_offset);
        }
        if !complete {
            return;
        }
        self.hash.update(line);
        self.hash.update(b"\n");
        self.committed_offset = line_offset + line.len() as u64 + 1;
        if let Some(state) = &self.resume
            && self.verified.is_none()
        {
            if self.committed_offset == state.committed_offset {
                self.verified = Some(self.hash.digest() == state.committed_digest);
            } else if self.committed_offset > state.committed_offset {
                self.verified = Some(false);
            }
        }
    }

    fn finish_projection(mut self) -> Option<SessionHistory> {
        if !self.partial_line.is_empty() {
            let line = std::mem::take(&mut self.partial_line);
            self.push_line(&line, self.partial_line_offset, false);
        }
        let resume = self.resume.take();
        if resume.is_some() && self.verified != Some(true) {
            return None;
        }
        let base = resume.as_ref().map(|state| &state.checkpoint);
        let mut entries = std::mem::take(&mut self.entries);
        let branch = active_branch_indices(
            &entries,
            base.map(|checkpoint| checkpoint.entry_id.as_str()),
        )?;

        // Read-only passes run first: projection moves payloads out of `entries`.
        let header_missing = match base {
            Some(checkpoint) => checkpoint.header_missing,
            None => !entries.first().is_some_and(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("session")
                    && entry
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
            }),
        };
        let checkpoint = branch
            .iter()
            .rposition(|index| self.checkpoint_hashes.contains_key(index));
        let checkpoint_entry = checkpoint.map(|position| branch[position]);
        let context_before = base.and_then(|checkpoint| checkpoint.stats.context_tokens);
        let mut stats = base
            .map(|checkpoint| checkpoint.stats.clone())
            .unwrap_or_default();
        // Entries are in source order, so this split is "before the checkpoint line".
        let split = checkpoint_entry.unwrap_or(entries.len());
        accumulate_history_stats(&mut stats, &entries[..split]);
        let checkpoint_stats = checkpoint.map(|position| SessionHistoryStats {
            context_tokens: branch_context_tokens(&entries, &branch[..position], context_before),
            ..stats.clone()
        });
        accumulate_history_stats(&mut stats, &entries[split..]);
        stats.context_tokens = branch_context_tokens(&entries, &branch, context_before);
        let checkpoint_id = checkpoint_entry.and_then(|index| {
            entries[index]
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });

        let start = base
            .map(|checkpoint| checkpoint.state.clone())
            .unwrap_or_default();
        let (mut history, checkpoint_state) =
            project_branch(&mut entries, &branch, start, checkpoint);
        history.header_missing = header_missing;
        history.stats = stats;
        history.image_locations = std::mem::take(&mut self.image_locations);
        history.first_message_index = base.map_or(0, |checkpoint| checkpoint.message_index);
        history.incremental = checkpoint_entry
            .zip(checkpoint_id)
            .zip(checkpoint_state.zip(checkpoint_stats))
            .and_then(|((index, entry_id), (state, stats))| {
                Some(IncrementalState {
                    checkpoint: HistoryCheckpoint {
                        entry_id,
                        file_offset: self.entry_offsets[index],
                        message_index: 0,
                        hash_state: self.checkpoint_hashes.remove(&index)?,
                        state,
                        stats,
                        header_missing,
                    },
                    committed_offset: self.committed_offset,
                    committed_digest: self.hash.digest(),
                    updates: resume.as_ref().map_or(0, |state| state.updates + 1),
                })
            });
        Some(history)
    }
}

#[cfg(test)]
pub(super) fn parse_history(bytes: &[u8]) -> SessionHistory {
    let mut parser = HistoryParser::default();
    parser.push(bytes);
    parser.finish()
}

fn parse_entry(
    line: &[u8],
    line_offset: u64,
    image_locations: &mut HashMap<String, ImageLocation>,
) -> Option<Value> {
    if line.is_empty() {
        return None;
    }
    let (line, line_offset) = line
        .strip_prefix(b"\xef\xbb\xbf")
        .map_or((line, line_offset), |line| (line, line_offset + 3));
    let mut value = serde_json::from_slice::<Value>(line).ok()?;
    record_image_locations(&value, line_offset, line.len() as u64, image_locations);
    // User images are fetched from their original JSONL range, not projected
    // from this payload. Release base64 data as soon as the range is indexed.
    if value.pointer("/message/role").and_then(Value::as_str) == Some("user")
        && let Some(parts) = value
            .pointer_mut("/message/content")
            .and_then(Value::as_array_mut)
    {
        for part in parts {
            if part.get("type").and_then(Value::as_str) == Some("image")
                && let Some(image) = part.as_object_mut()
            {
                image.remove("data");
            }
        }
    }
    Some(value)
}

/// User messages and compactions close the previous turn and start their own
/// projected message, so nothing projected before them depends on later entries.
fn is_checkpoint_candidate(entry: &Value) -> bool {
    entry
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && match entry.get("type").and_then(Value::as_str) {
            Some("compaction") => true,
            Some("message") => {
                entry.pointer("/message/role").and_then(Value::as_str) == Some("user")
            }
            _ => false,
        }
}

/// Resolves the active branch from the last entry with an id. With `anchor`, the
/// entries are a resumed tail whose first entry is the checkpoint: the branch must
/// reach it, otherwise `None` asks for a full read.
fn active_branch_indices(entries: &[Value], anchor: Option<&str>) -> Option<Vec<usize>> {
    let mut by_id = HashMap::<&str, usize>::new();
    let mut leaf = None;
    for (index, entry) in entries.iter().enumerate() {
        if let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            by_id.insert(id, index);
            leaf = Some(index);
        }
    }
    let Some(mut current) = leaf else {
        return anchor.is_none().then(|| (0..entries.len()).collect());
    };

    let mut indices = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current) {
            if anchor.is_some() {
                return None;
            }
            break;
        }
        indices.push(current);
        if let Some(anchor) = anchor
            && current == 0
        {
            if entries[0].get("id").and_then(Value::as_str) != Some(anchor) {
                return None;
            }
            break;
        }
        let parent = entries[current]
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|parent_id| by_id.get(parent_id).copied());
        let Some(parent) = parent else {
            if anchor.is_some() {
                return None;
            }
            break;
        };
        current = parent;
    }
    indices.reverse();

    if anchor.is_none()
        && let Some(header) = entries.first()
        && header.get("type").and_then(Value::as_str) == Some("session")
        && header.get("id").is_none()
    {
        indices.insert(0, 0);
    }
    Some(indices)
}
