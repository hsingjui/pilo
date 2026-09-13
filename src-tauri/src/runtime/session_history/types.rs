use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryModel {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub events: Vec<ConversationEventDto>,
    pub model: Option<SessionHistoryModel>,
    pub thinking_level: Option<String>,
    pub name: Option<String>,
    pub source_message_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConversationEventDto {
    UserMessageStart {
        text: String,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
    },
    AssistantMessageStart {
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
    },
    AssistantTextDelta {
        delta: String,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    AssistantThinkingStart {
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    AssistantThinkingDelta {
        delta: String,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    AssistantThinkingEnd {
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Value,
        #[serde(rename = "isError")]
        is_error: bool,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
    },
    AssistantTurnEnd {
        #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        completion: TurnCompletion,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompletion {
    Complete,
    Interrupted,
}
