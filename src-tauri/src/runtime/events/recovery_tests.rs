use super::RuntimeEvent;

#[derive(Debug, PartialEq)]
enum RecoveryClass {
    FullValue,
    InvalidateOnly,
    ChatSession,
}

fn recovery_class(event: &RuntimeEvent) -> RecoveryClass {
    match event {
        RuntimeEvent::PreferencesChanged { .. }
        | RuntimeEvent::ThemeSettingsChanged { .. }
        | RuntimeEvent::ExternalSessionActivityChanged { .. }
        | RuntimeEvent::SessionReadStateChanged { .. }
        | RuntimeEvent::CacheKeepAliveSettingsChanged { .. }
        | RuntimeEvent::NextPromptSettingsChanged { .. }
        | RuntimeEvent::PromptEnhancementSettingsChanged { .. }
        | RuntimeEvent::ProjectModelScopeChanged { .. } => RecoveryClass::FullValue,
        RuntimeEvent::ConfigurationChanged
        | RuntimeEvent::SessionTurnCompleted { .. }
        | RuntimeEvent::SessionsIndexed { .. }
        | RuntimeEvent::SessionIndexError { .. } => RecoveryClass::InvalidateOnly,
        RuntimeEvent::ProcessState { .. }
        | RuntimeEvent::RpcMessage { .. }
        | RuntimeEvent::UserMessageStart { .. }
        | RuntimeEvent::AssistantMessageStart { .. }
        | RuntimeEvent::AssistantUsageUpdate { .. }
        | RuntimeEvent::AssistantTextDelta { .. }
        | RuntimeEvent::AssistantTextSnapshot { .. }
        | RuntimeEvent::AssistantThinkingStart { .. }
        | RuntimeEvent::AssistantThinkingDelta { .. }
        | RuntimeEvent::AssistantThinkingEnd { .. }
        | RuntimeEvent::ToolExecutionStart { .. }
        | RuntimeEvent::ToolExecutionUpdate { .. }
        | RuntimeEvent::ToolExecutionEnd { .. }
        | RuntimeEvent::PiReattached { .. }
        | RuntimeEvent::AssistantMessageEnd { .. }
        | RuntimeEvent::QueueUpdate { .. }
        | RuntimeEvent::CompactionStart { .. }
        | RuntimeEvent::CompactionEnd { .. }
        | RuntimeEvent::AutoRetryStart { .. }
        | RuntimeEvent::AutoRetryEnd { .. }
        | RuntimeEvent::SummarizationRetryScheduled { .. }
        | RuntimeEvent::SummarizationRetryAttemptStart { .. }
        | RuntimeEvent::SummarizationRetryFinished { .. }
        | RuntimeEvent::ExtensionUiRequest { .. }
        | RuntimeEvent::RuntimeLog { .. }
        | RuntimeEvent::RuntimeError { .. } => RecoveryClass::ChatSession,
    }
}

#[test]
fn every_runtime_variant_requires_an_explicit_recovery_class() {
    assert_eq!(
        recovery_class(&RuntimeEvent::ConfigurationChanged),
        RecoveryClass::InvalidateOnly
    );
    assert_eq!(
        recovery_class(&RuntimeEvent::ExternalSessionActivityChanged {
            project_id: "p".into(),
            activities: Vec::new()
        }),
        RecoveryClass::FullValue
    );
    assert_eq!(
        recovery_class(&RuntimeEvent::AssistantTextDelta {
            generation: 1,
            delta: "x".into()
        }),
        RecoveryClass::ChatSession
    );
}
