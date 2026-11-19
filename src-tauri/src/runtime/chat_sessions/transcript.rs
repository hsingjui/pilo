use std::sync::atomic::Ordering;

use super::ChatSessions;
use crate::runtime::transcript::{TranscriptSnapshot, TranscriptWindow};

impl ChatSessions {
    pub(crate) async fn transcript_snapshot(
        &self,
        session_key: &str,
        window: TranscriptWindow,
    ) -> Result<TranscriptSnapshot, String> {
        let process = self
            .registry
            .lock()
            .await
            .processes
            .get(session_key)
            .cloned()
            .ok_or_else(|| "chat session is not running".to_owned())?;
        if process.closed.load(Ordering::Acquire) {
            return Err("chat session is closing".to_owned());
        }
        let path = process
            .session_path
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let snapshot = process
            .turn
            .snapshot(&process.events, session_key, path, window)
            .await?;
        if process.closed.load(Ordering::Acquire) {
            return Err("chat session is closing".to_owned());
        }
        Ok(snapshot)
    }
}
