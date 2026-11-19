use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{events::turn_projection::TurnLive, handle::Runtime};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// Uses the history reader's tail window and 1–256 limit; None loads all messages.
pub struct TranscriptWindow {
    pub start_message: Option<usize>,
    pub message_limit: Option<usize>,
    #[serde(default)]
    pub include_message_index: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// A transcript cut. Truncated results require resynchronization, not replay.
pub struct TranscriptSnapshot {
    pub event_sequence: u64,
    pub session_key: String,
    pub generation: u64,
    pub history: Value,
    pub live: TurnLive,
}

impl Runtime {
    /// Captures a session's history and live turn at an ordered runtime event cut.
    pub async fn chat_transcript_snapshot(
        &self,
        session_key: &str,
        window: TranscriptWindow,
    ) -> Result<TranscriptSnapshot, String> {
        self.chat_sessions
            .transcript_snapshot(session_key, window)
            .await
    }
}
