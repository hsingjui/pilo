use serde::Serialize;
use serde_json::Value;

use super::super::token_usage::TokenUsage;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PiProcessState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLogStream {
    Stderr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorCode {
    SpawnFailed,
    ProcessIo,
    RpcDecode,
    RpcFraming,
    RpcResponse,
    ProcessExit,
    ProcessWait,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUiRequestPayload {
    pub id: String,
    pub method: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub options: Vec<String>,
    pub placeholder: Option<String>,
    pub prefill: Option<String>,
    pub timeout: Option<u64>,
    pub notify_type: Option<String>,
    pub status_key: Option<String>,
    pub status_text: Option<String>,
    pub widget_key: Option<String>,
    pub widget_lines: Option<Vec<String>>,
    pub widget_placement: Option<String>,
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUserImage {
    pub id: String,
    pub mime_type: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    PreferencesChanged {
        settings: super::super::preferences::PreferencesSnapshot,
    },
    ConfigurationChanged,
    ThemeSettingsChanged {
        settings: pilo_domain::ThemeSettings,
    },
    SessionTurnCompleted {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "sessionPath")]
        session_path: String,
        #[serde(rename = "completionId")]
        completion_id: String,
    },
    SessionsIndexed {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    SessionIndexError {
        #[serde(rename = "projectId")]
        project_id: String,
        message: String,
    },
    /// Host-detected external Pi activity changed for one project.
    ExternalSessionActivityChanged {
        #[serde(rename = "projectId")]
        project_id: String,
        activities: Vec<super::super::session_activity::SessionExternalActivity>,
    },
    SessionReadStateChanged {
        state: pilo_domain::SessionReadState,
        #[serde(rename = "completionId", skip_serializing_if = "Option::is_none")]
        completion_id: Option<String>,
    },
    CacheKeepAliveSettingsChanged {
        settings: pilo_domain::CacheKeepAliveSettings,
    },
    NextPromptSettingsChanged {
        settings: pilo_domain::NextPromptSettings,
    },
    PromptEnhancementSettingsChanged {
        settings: pilo_domain::PromptEnhancementSettings,
    },
    ProjectModelScopeChanged {
        scope: pilo_domain::ProjectModelScope,
    },
    ProcessState {
        generation: u64,
        state: PiProcessState,
    },
    RpcMessage {
        generation: u64,
        message: Value,
    },
    UserMessageStart {
        generation: u64,
        text: String,
    },
    AssistantMessageStart {
        generation: u64,
    },
    AssistantUsageUpdate {
        generation: u64,
        usage: TokenUsage,
    },
    AssistantTextDelta {
        generation: u64,
        delta: String,
    },
    AssistantTextSnapshot {
        generation: u64,
        text: String,
    },
    AssistantThinkingStart {
        generation: u64,
    },
    AssistantThinkingDelta {
        generation: u64,
        delta: String,
    },
    AssistantThinkingEnd {
        generation: u64,
    },
    ToolExecutionStart {
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "partialResult")]
        partial_result: Value,
    },
    ToolExecutionEnd {
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Value,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    PiReattached {
        generation: u64,
        active: bool,
        compacting: bool,
    },
    AssistantMessageEnd {
        generation: u64,
        #[serde(rename = "stopReason")]
        stop_reason: Option<String>,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
        /// 当前回复段累计的模型用量，包含工具结果上报的嵌套调用。
        usage: Option<TokenUsage>,
    },
    QueueUpdate {
        generation: u64,
        steering: Vec<String>,
        #[serde(rename = "followUp")]
        follow_up: Vec<String>,
    },
    CompactionStart {
        generation: u64,
        reason: String,
    },
    CompactionEnd {
        generation: u64,
        reason: String,
        result: Option<Value>,
        aborted: bool,
        #[serde(rename = "willRetry")]
        will_retry: bool,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
    },
    AutoRetryStart {
        generation: u64,
        attempt: u64,
        #[serde(rename = "maxAttempts")]
        max_attempts: u64,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(rename = "errorMessage")]
        error_message: String,
    },
    AutoRetryEnd {
        generation: u64,
        success: bool,
        attempt: u64,
        #[serde(rename = "finalError")]
        final_error: Option<String>,
    },
    SummarizationRetryScheduled {
        generation: u64,
        attempt: u64,
        #[serde(rename = "maxAttempts")]
        max_attempts: u64,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(rename = "errorMessage")]
        error_message: String,
    },
    SummarizationRetryAttemptStart {
        generation: u64,
        source: String,
        reason: Option<String>,
    },
    SummarizationRetryFinished {
        generation: u64,
    },
    ExtensionUiRequest {
        generation: u64,
        #[serde(flatten)]
        request: Box<ExtensionUiRequestPayload>,
    },
    RuntimeLog {
        generation: u64,
        stream: RuntimeLogStream,
        message: String,
    },
    RuntimeError {
        generation: u64,
        code: RuntimeErrorCode,
        message: String,
    },
}

impl RuntimeEvent {
    /// The Pi generation an event belongs to, when it is generation-scoped.
    /// Session-level events (indexing, preferences, lifecycle) return `None`.
    pub fn generation(&self) -> Option<u64> {
        match self {
            RuntimeEvent::ProcessState { generation, .. }
            | RuntimeEvent::RpcMessage { generation, .. }
            | RuntimeEvent::UserMessageStart { generation, .. }
            | RuntimeEvent::AssistantMessageStart { generation }
            | RuntimeEvent::AssistantUsageUpdate { generation, .. }
            | RuntimeEvent::AssistantTextDelta { generation, .. }
            | RuntimeEvent::AssistantTextSnapshot { generation, .. }
            | RuntimeEvent::AssistantThinkingStart { generation }
            | RuntimeEvent::AssistantThinkingDelta { generation, .. }
            | RuntimeEvent::AssistantThinkingEnd { generation }
            | RuntimeEvent::ToolExecutionStart { generation, .. }
            | RuntimeEvent::ToolExecutionUpdate { generation, .. }
            | RuntimeEvent::ToolExecutionEnd { generation, .. }
            | RuntimeEvent::PiReattached { generation, .. }
            | RuntimeEvent::AssistantMessageEnd { generation, .. }
            | RuntimeEvent::QueueUpdate { generation, .. }
            | RuntimeEvent::CompactionStart { generation, .. }
            | RuntimeEvent::CompactionEnd { generation, .. }
            | RuntimeEvent::AutoRetryStart { generation, .. }
            | RuntimeEvent::AutoRetryEnd { generation, .. }
            | RuntimeEvent::SummarizationRetryScheduled { generation, .. }
            | RuntimeEvent::SummarizationRetryAttemptStart { generation, .. }
            | RuntimeEvent::SummarizationRetryFinished { generation }
            | RuntimeEvent::ExtensionUiRequest { generation, .. }
            | RuntimeEvent::RuntimeLog { generation, .. }
            | RuntimeEvent::RuntimeError { generation, .. } => Some(*generation),
            RuntimeEvent::PreferencesChanged { .. }
            | RuntimeEvent::ConfigurationChanged
            | RuntimeEvent::ThemeSettingsChanged { .. }
            | RuntimeEvent::SessionTurnCompleted { .. }
            | RuntimeEvent::SessionsIndexed { .. }
            | RuntimeEvent::SessionIndexError { .. }
            | RuntimeEvent::ExternalSessionActivityChanged { .. }
            | RuntimeEvent::SessionReadStateChanged { .. }
            | RuntimeEvent::CacheKeepAliveSettingsChanged { .. }
            | RuntimeEvent::NextPromptSettingsChanged { .. }
            | RuntimeEvent::PromptEnhancementSettingsChanged { .. }
            | RuntimeEvent::ProjectModelScopeChanged { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<LiveUserImage>,
    #[serde(flatten)]
    pub event: RuntimeEvent,
}

impl RuntimeEventEnvelope {
    pub fn global(event: RuntimeEvent) -> Self {
        Self {
            session_key: None,
            project_id: None,
            timestamp_ms: None,
            images: Vec::new(),
            event,
        }
    }

    pub fn session(session_key: String, project_id: String, event: RuntimeEvent) -> Self {
        Self {
            session_key: Some(session_key),
            project_id: Some(project_id),
            timestamp_ms: None,
            images: Vec::new(),
            event,
        }
    }
}
