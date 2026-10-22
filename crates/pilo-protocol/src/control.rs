use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CONTROL_MAX_BYTES: usize = 1024 * 1024;
pub const CONTROL_TIMEOUT_SECONDS: u64 = 60;

/// Child-only capability. Never include this value in logs or Runtime events.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlContext {
    pub endpoint: String,
    pub token: String,
    pub executable: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlCommand {
    pub method: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub value: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ControlCall {
    pub token: String,
    pub command: ControlCommand,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ControlReply {
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlRequest {
    pub id: u64,
    pub command: ControlCommand,
}
