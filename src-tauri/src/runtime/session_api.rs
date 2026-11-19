use super::{Runtime, project, storage};
#[cfg(feature = "tauri")]
use super::{pi_workspace, session_activity::SessionExternalActivity};
use crate::domain::{SessionIndexEntry, SessionUiStateUpdate};
use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri")]
use std::sync::Arc;
#[cfg(feature = "tauri")]
fn session_runtime_project(
    runtime: &Runtime,
    project_id: &str,
) -> Result<crate::domain::Project, String> {
    let project = project::get(runtime, project_id)?;
    pi_workspace::resolve_session_project_with_paths(&runtime.paths, &project)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteResult {
    method: String,
}

pub fn session_list(
    runtime: &Runtime,
    project_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    storage::list_sessions(&storage::open(&runtime.paths)?, &project_id)
}

#[cfg(feature = "tauri")]
pub async fn session_watch_start(runtime: &Runtime, project_id: String) -> Result<(), String> {
    let project = project::get(runtime, &project_id)?;
    runtime
        .session_watchers
        .lock()
        .await
        .start(Arc::clone(&runtime.servers), runtime.clone(), project)
        .await
}

#[cfg(feature = "tauri")]
pub async fn session_watch_stop(runtime: &Runtime, project_id: String) -> Result<(), String> {
    runtime
        .session_watchers
        .lock()
        .await
        .stop(&project_id)
        .await;
    Ok(())
}

#[cfg(feature = "tauri")]
pub async fn session_delete(
    runtime: &Runtime,
    project_id: String,
    session_path: String,
) -> Result<SessionDeleteResult, String> {
    let project = session_runtime_project(runtime, &project_id)?;
    let db = storage::open(&runtime.paths)?;
    let indexed = storage::get_session(&db, &session_path, Some(&project.id))?
        .ok_or_else(|| format!("session '{session_path}' is not indexed"))?;
    if indexed.project_id != project.id {
        return Err("session belongs to a different project".to_owned());
    }

    runtime
        .chat_sessions
        .stop_session_file(&project, &session_path)
        .await?;
    super::session_activity::reject_external_session_owner(runtime, &project, Some(&session_path))
        .await?;

    let value = runtime
        .servers
        .request(
            &project.connection,
            "session.delete",
            serde_json::json!({ "path": session_path }),
        )
        .await?;
    let method = value
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unlink")
        .to_owned();
    storage::remove_session_for_project(&db, &project.id, &indexed.session_path)?;
    runtime
        .session_history_cache
        .lock()
        .await
        .invalidate(&project, &indexed.session_path);
    Ok(SessionDeleteResult { method })
}

pub fn session_update_ui_state(
    runtime: &Runtime,
    session_path: String,
    update: SessionUiStateUpdate,
    project_id: Option<String>,
) -> Result<SessionIndexEntry, String> {
    storage::update_session_ui_state(
        &storage::open(&runtime.paths)?,
        &session_path,
        &update,
        project_id.as_deref(),
    )
}

#[cfg(feature = "tauri")]
pub async fn session_external_activity(
    runtime: &Runtime,
    project_id: String,
) -> Result<Vec<SessionExternalActivity>, String> {
    let project = session_runtime_project(runtime, &project_id)?;
    runtime
        .events
        .external_session_activity(runtime, &project)
        .await
}

#[cfg(feature = "tauri")]
pub async fn session_search(
    runtime: &Runtime,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SessionSearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let project = session_runtime_project(runtime, &project_id)?;
    if project.default_workspace_pending() {
        return Ok(Vec::new());
    }
    runtime
        .servers
        .request_typed(
            &project.connection,
            "session.search",
            serde_json::json!({
                "project": project.path,
                "query": query,
                "limit": limit.unwrap_or(24),
            }),
        )
        .await
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchMatch {
    pub session_path: String,
    pub session_id: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_functions_preserve_cached_entries_and_ui_state_validation() {
        let root =
            std::env::temp_dir().join(format!("pilo-runtime-sessions-{}", std::process::id()));
        let runtime = Runtime::new(
            super::super::host_paths::HostPaths::new(root.clone(), root.join("resources")).unwrap(),
            std::sync::Arc::new(super::super::host_events::RecordingEvents::default()),
        );
        assert!(session_list(&runtime, "project".into()).unwrap().is_empty());
        assert!(
            session_update_ui_state(
                &runtime,
                "missing".into(),
                SessionUiStateUpdate::default(),
                None
            )
            .is_err()
        );
        let db = storage::open(&runtime.paths).unwrap();
        let connection = storage::ensure_local_connection(&db).unwrap();
        storage::upsert_project(
            &db,
            &crate::domain::Project {
                id: "project".into(),
                name: "project".into(),
                path: "/project".into(),
                connection,
                metadata: crate::domain::ProjectMetadata {
                    cwd: "/project".into(),
                    git_branch: None,
                    pi_version: String::new(),
                    refreshed_at_ms: 0,
                },
                created_at_ms: 0,
                last_opened_at_ms: 0,
            },
        )
        .unwrap();
        storage::upsert_session(
            &db,
            &SessionIndexEntry {
                connection_id: "local".into(),
                project_id: "project".into(),
                pi_session_id: "session".into(),
                session_path: "/session.jsonl".into(),
                name: None,
                cwd: "/project".into(),
                created_at: String::new(),
                updated_at: String::new(),
                message_count: 0,
                last_message_at: None,
                first_user_message_preview: None,
                file_size: 0,
                file_mtime_ns: 0,
                last_offset: 0,
                indexed_at_ms: 0,
                pinned: false,
                title_override: None,
            },
        )
        .unwrap();
        let state = session_update_ui_state(
            &runtime,
            "/session.jsonl".into(),
            SessionUiStateUpdate {
                pinned: true,
                title_override: Some("Title".into()),
            },
            Some("project".into()),
        )
        .unwrap();
        assert!(state.pinned);
        assert_eq!(state.title_override.as_deref(), Some("Title"));
        assert_eq!(
            session_list(&runtime, "project".into()).unwrap(),
            vec![state]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
