use serde_json::json;

use crate::domain::{NextPromptModel, NextPromptRequest, NextPromptSettings};

use super::{
    PiloRuntime, RuntimeEventBus,
    debug_trace::runtime_trace,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    host_paths::HostPaths,
    storage,
};

pub(crate) fn load(paths: &HostPaths, connection_id: &str) -> Result<NextPromptSettings, String> {
    storage::get_next_prompt_settings(&storage::open_with_paths(paths)?, connection_id)
}

pub(crate) fn save(
    paths: &HostPaths,
    events: &RuntimeEventBus,
    connection_id: &str,
    enabled: bool,
    model: Option<NextPromptModel>,
) -> Result<NextPromptSettings, String> {
    let settings = storage::set_next_prompt_settings(
        &storage::open_with_paths(paths)?,
        connection_id,
        enabled,
        model,
    )?;
    events.send(RuntimeEventEnvelope {
        session_key: None,
        project_id: None,
        timestamp_ms: None,
        event: RuntimeEvent::NextPromptSettingsChanged {
            settings: settings.clone(),
        },
    });
    Ok(settings)
}

pub(crate) async fn request(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    request: NextPromptRequest,
) -> Result<(), String> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || request.session_id.is_empty()
        || request.session_id.len() > 256
        || request.session_key.len() > 4096
    {
        return Err("invalid next prompt request identity".to_owned());
    }
    let _policy = runtime.pi_resource_policy.read().await;
    // Look up an existing process only. Browsing history must never start Pi.
    let state = runtime
        .chat_sessions
        .state(&request.session_key)
        .await
        .ok_or_else(|| {
            runtime_trace(
                "next_prompt.reject",
                Some(&request.session_key),
                None,
                json!({ "requestId": request.request_id, "reason": "process_missing" }),
            );
            "prediction session is not running".to_owned()
        })?;
    let settings = {
        let db = storage::open_with_paths(paths)?;
        let project = storage::get_project(&db, &state.project_id)?
            .ok_or_else(|| "prediction project was not found".to_owned())?;
        storage::get_next_prompt_settings(&db, &project.connection.id)?
    };
    if !request.cancel && (!settings.enabled || settings.updated_at_ms != request.revision) {
        runtime_trace(
            "next_prompt.reject",
            Some(&request.session_key),
            None,
            json!({
                "requestId": request.request_id,
                "revision": request.revision,
                "reason": if settings.enabled { "revision_changed" } else { "disabled" },
            }),
        );
        return Err("prediction settings changed".to_owned());
    }
    // Cancellation identifies only this client's request, even after settings change.
    let payload = json!({
        "requestId": request.request_id,
        "sessionId": request.session_id,
        "revision": request.revision,
        "model": settings.model,
        "cancel": request.cancel,
    });
    runtime.chat_sessions.send_input_assistance(
        &request.session_key, &state.project_id, request.generation, request.cancel,
        json!({ "id": format!("pilo-next-prompt-{}-{}", request.request_id, request.cancel), "type": "prompt", "message": format!("/pilo-next-prompt {payload}") }),
    ).await
}
