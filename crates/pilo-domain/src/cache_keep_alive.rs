use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheKeepAliveSettings {
    pub connection_id: String,
    pub provider: String,
    pub model_id: String,
    pub enabled: bool,
    pub cache_ttl_seconds: u32,
    pub idle_keep_alive_seconds: u32,
    #[serde(default)]
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheKeepAliveStatus {
    pub ready: bool,
    pub status: String,
    pub reason: String,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub expires_at_ms: u64,
    pub next_warm_at_ms: Option<u64>,
    pub request_count: u64,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub cost: Option<f64>,
}
