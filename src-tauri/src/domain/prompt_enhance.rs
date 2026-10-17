use serde::Deserialize;

/// Model reference for a one-off prompt rewrite; `None` follows Pi's default.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhanceModel {
    pub provider: String,
    pub id: String,
}
