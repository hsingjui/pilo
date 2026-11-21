use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextPromptModel {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextPromptSettings {
    pub connection_id: String,
    pub enabled: bool,
    pub model: Option<NextPromptModel>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextPromptRequest {
    pub session_key: String,
    pub session_id: String,
    pub request_id: String,
    pub generation: u64,
    pub revision: u64,
    #[serde(default)]
    pub cancel: bool,
}
