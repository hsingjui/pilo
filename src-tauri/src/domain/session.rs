use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub connection_id: String,
    pub project_id: String,
    pub pi_session_id: String,
    pub session_path: String,
    pub name: Option<String>,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u64,
    pub last_message_at: Option<String>,
    pub first_user_message_preview: Option<String>,
    pub file_size: u64,
    pub file_mtime_ns: u64,
    pub last_offset: u64,
    pub indexed_at_ms: u64,
    pub pinned: bool,
    pub archived: bool,
    pub title_override: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUiStateUpdate {
    pub pinned: bool,
    pub archived: bool,
    pub title_override: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReconcileResult {
    pub sessions: Vec<SessionIndexEntry>,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub unchanged: u64,
}
