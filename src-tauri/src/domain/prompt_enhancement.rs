use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhancementModel {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhancementSettings {
    pub connection_id: String,
    pub enabled: bool,
    pub model: Option<PromptEnhancementModel>,
    pub updated_at_ms: u64,
}
