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
mod transcript;
mod types;

pub(crate) use transcript::{
    TranscriptBase, empty_transcript_history, read_transcript_history, record_transcript_base,
};

pub(crate) use cache::SessionHistoryCache;
#[cfg(test)]
pub(crate) use cache::cache_key;
pub use images::read_history_image_bytes;
pub(crate) use reader::{
    RemoteTranscriptBase, read_remote_transcript_history, record_remote_transcript_base,
};
pub use reader::{read_history_json, read_history_window_json};

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn full_history_snapshot_for_test(bytes: &[u8]) -> serde_json::Value {
    let (history, _) = serialize::serialize_windowed_history(parser::parse_history(bytes)).unwrap();
    serde_json::from_slice(&serialize::serialize_history_response(&history, None)).unwrap()
}
