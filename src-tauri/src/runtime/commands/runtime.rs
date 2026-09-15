use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State};

use super::super::{
    PiloRuntime, events::TauriEventSink, project, server_pi::PiLaunchOptions,
    session_snapshot::PiSessionSnapshot,
};
use super::sessions::{SessionExternalActivity, external_session_activities_for_project};

fn session_has_external_open_turn(
    activities: &[SessionExternalActivity],
    session_path: &str,
) -> bool {
    activities
        .iter()
        .any(|activity| activity.turn_open && activity.path == session_path)
}

async fn reject_external_session_owner(
    runtime: &PiloRuntime,
    project: &crate::domain::Project,
    session_path: Option<&str>,
) -> Result<(), String> {
    let Some(session_path) = session_path else {
        return Ok(());
    };
    let activities = external_session_activities_for_project(runtime, project).await?;
    if session_has_external_open_turn(&activities, session_path) {
        return Err(
            "session is currently owned by an external Pi process; Pilo opened it in read-only observer mode"
                .to_owned(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn chat_session_prepare(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &project_id)?;
    reject_external_session_owner(&runtime, &project, session_path.as_deref()).await?;
    runtime
        .chat_sessions
        .prepare(
            Arc::clone(&runtime.servers),
            app,
            project,
            session_key,
            session_path,
            no_session,
        )
        .await
}

#[tauri::command]
pub async fn chat_session_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &project_id)?;
    reject_external_session_owner(&runtime, &project, session_path.as_deref()).await?;
    runtime
        .chat_sessions
        .ensure(
            Arc::clone(&runtime.servers),
            app,
            project,
            session_key,
            session_path,
            no_session,
        )
        .await
}

#[tauri::command]
pub async fn chat_session_send_rpc(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    command: Value,
) -> Result<(), String> {
    runtime.chat_sessions.send(&session_key, command).await
}

#[tauri::command]
pub async fn chat_session_stop(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
) -> Result<(), String> {
    runtime.chat_sessions.stop(&session_key).await
}

#[tauri::command]
pub async fn chat_session_state(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
) -> Result<Option<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.state(&session_key).await)
}

#[tauri::command]
pub async fn chat_session_states(
    runtime: State<'_, PiloRuntime>,
) -> Result<Vec<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.states().await)
}

#[tauri::command]
pub async fn project_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &id)?;
    project::touch(&app, &project.id)?;
    runtime
        .project_pi_session
        .lock()
        .await
        .spawn(
            Arc::clone(&runtime.servers),
            TauriEventSink::new(app),
            &project,
            PiLaunchOptions::default(),
        )
        .await
}

#[tauri::command]
pub async fn runtime_get_pi_state(
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    Ok(runtime.project_pi_session.lock().await.snapshot())
}

#[tauri::command]
pub async fn runtime_stop_pi(runtime: State<'_, PiloRuntime>) -> Result<PiSessionSnapshot, String> {
    runtime.project_pi_session.lock().await.stop().await
}

#[tauri::command]
pub async fn runtime_restart_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    runtime
        .project_pi_session
        .lock()
        .await
        .restart(Arc::clone(&runtime.servers), TauriEventSink::new(app))
        .await
}

#[tauri::command]
pub async fn runtime_abort_pi(runtime: State<'_, PiloRuntime>) -> Result<(), String> {
    runtime.project_pi_session.lock().await.abort().await
}

#[tauri::command]
pub async fn runtime_send_rpc(
    runtime: State<'_, PiloRuntime>,
    command: Value,
) -> Result<(), String> {
    runtime
        .project_pi_session
        .lock()
        .await
        .send_rpc(command)
        .await
}

#[cfg(test)]
mod tests {
    use super::{SessionExternalActivity, session_has_external_open_turn};

    #[test]
    fn only_open_external_turns_block_session_ownership() {
        let activities = vec![
            SessionExternalActivity {
                path: "/tmp/idle.jsonl".to_owned(),
                turn_open: false,
            },
            SessionExternalActivity {
                path: "/tmp/running.jsonl".to_owned(),
                turn_open: true,
            },
        ];

        assert!(!session_has_external_open_turn(
            &activities,
            "/tmp/idle.jsonl"
        ));
        assert!(session_has_external_open_turn(
            &activities,
            "/tmp/running.jsonl"
        ));
        assert!(!session_has_external_open_turn(
            &activities,
            "/tmp/unknown.jsonl"
        ));
    }
}
