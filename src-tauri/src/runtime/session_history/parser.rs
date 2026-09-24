use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::parser_fields::record_image_locations;
use super::parser_projection::project_branch;
use super::parser_stats::collect_history_stats;
use super::types::{ImageLocation, SessionHistory};

#[derive(Default)]
pub(super) struct HistoryParser {
    entries: Vec<Value>,
    partial_line: Vec<u8>,
    partial_line_offset: u64,
    consumed_bytes: u64,
    image_locations: HashMap<String, ImageLocation>,
}

impl HistoryParser {
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
            let line_offset = self.partial_line_offset;
            let line = std::mem::take(&mut self.partial_line);
            push_entry(
                &mut self.entries,
                &line,
                line_offset,
                &mut self.image_locations,
            );
            bytes = &bytes[newline + 1..];
            absolute += (newline + 1) as u64;
        }

        let mut start = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            push_entry(
                &mut self.entries,
                &bytes[start..index],
                absolute + start as u64,
                &mut self.image_locations,
            );
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

    pub(super) fn finish(mut self) -> SessionHistory {
        if !self.partial_line.is_empty() {
            let line_offset = self.partial_line_offset;
            let line = std::mem::take(&mut self.partial_line);
            push_entry(
                &mut self.entries,
                &line,
                line_offset,
                &mut self.image_locations,
            );
        }
        let mut history = parse_history_entries(&self.entries);
        history.image_locations = self.image_locations;
        history
    }
}

#[cfg(test)]
pub(super) fn parse_history(bytes: &[u8]) -> SessionHistory {
    let mut parser = HistoryParser::default();
    parser.push(bytes);
    parser.finish()
}

fn push_entry(
    entries: &mut Vec<Value>,
    line: &[u8],
    line_offset: u64,
    image_locations: &mut HashMap<String, ImageLocation>,
) {
    if line.is_empty() {
        return;
    }
    if let Ok(value) = serde_json::from_slice::<Value>(line) {
        record_image_locations(&value, line_offset, line.len() as u64, image_locations);
        entries.push(value);
    }
}

fn active_branch_indices(entries: &[Value]) -> Vec<usize> {
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
        return (0..entries.len()).collect();
    };

    let mut indices = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current) {
            break;
        }
        indices.push(current);
        let Some(parent_id) = entries[current].get("parentId").and_then(Value::as_str) else {
            break;
        };
        let Some(parent) = by_id.get(parent_id).copied() else {
            break;
        };
        current = parent;
    }
    indices.reverse();

    if let Some(header) = entries.first()
        && header.get("type").and_then(Value::as_str) == Some("session")
        && header.get("id").is_none()
    {
        indices.insert(0, 0);
    }
    indices
}

fn parse_history_entries(entries: &[Value]) -> SessionHistory {
    let branch = active_branch_indices(entries);
    let mut history = project_branch(entries, &branch);
    history.stats = collect_history_stats(entries, &branch);
    history
}
