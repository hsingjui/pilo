mod cache;
mod disk;
mod images;
mod incremental;
mod parser;
mod parser_fields;
mod parser_projection;
mod parser_stats;
mod reader;
mod serialize;
mod types;

pub(crate) use cache::SessionHistoryCache;
pub use images::read_history_image_bytes;
pub use reader::{read_history_json, read_history_window_json};

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn full_history_snapshot_for_test(bytes: &[u8]) -> serde_json::Value {
    let (history, _) = serialize::serialize_windowed_history(parser::parse_history(bytes)).unwrap();
    serde_json::from_slice(&serialize::serialize_history_response(&history, None)).unwrap()
}
