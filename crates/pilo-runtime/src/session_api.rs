use super::{Runtime, project, storage};
use super::{
    events::{RuntimeEvent, RuntimeEventEnvelope},
    session_history,
    session_index::{self, SessionScanClient},
};
use super::{
    pi_workspace, session_activity::SessionExternalActivity, session_watcher::SessionWatcherManager,
};
use pilo_domain::SessionReconcileResult;
use pilo_domain::{SessionIndexEntry, SessionUiStateUpdate};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex as StdMutex};
fn session_runtime_project(
    runtime: &Runtime,
    project_id: &str,
) -> Result<pilo_domain::Project, String> {
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

pub async fn session_watch_start(runtime: &Runtime, project_id: String) -> Result<(), String> {
    let _scan = lock_session_index(runtime, &project_id).await;
    let project = project::get(runtime, &project_id)?;
    if project.default_workspace_pending() {
        return Ok(());
    }
    let session_project =
        pi_workspace::resolve_session_project_with_paths(&runtime.paths, &project)?;
    let client = runtime.servers.client(&session_project.connection).await?;
    SessionWatcherManager::start(
        &runtime.session_watchers,
        runtime,
        &project,
        session_project,
        client,
    )
    .await
}

pub async fn session_watch_stop(runtime: &Runtime, project_id: String) -> Result<(), String> {
    SessionWatcherManager::stop(&runtime.session_watchers, &project_id).await;
    Ok(())
}

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

    let _scan = lock_session_index(runtime, &project_id).await;
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
    let entry = storage::update_session_ui_state(
        &storage::open(&runtime.paths)?,
        &session_path,
        &update,
        project_id.as_deref(),
    )?;
    runtime.events.send(RuntimeEventEnvelope::global(
        RuntimeEvent::SessionsIndexed {
            project_id: entry.project_id.clone(),
        },
    ));
    Ok(entry)
}

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

struct BackgroundSessionIndexLease {
    manager: Arc<StdMutex<session_index::BackgroundSessionIndexManager>>,
    project_id: String,
    armed: bool,
}

impl BackgroundSessionIndexLease {
    fn new(
        manager: Arc<StdMutex<session_index::BackgroundSessionIndexManager>>,
        project_id: String,
    ) -> Self {
        Self {
            manager,
            project_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BackgroundSessionIndexLease {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut manager = self
            .manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        manager.worker_aborted(&self.project_id);
    }
}

pub(crate) async fn lock_session_index(
    runtime: &Runtime,
    project_id: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = runtime
        .background_session_index
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .scan_lock(project_id);
    lock.lock_owned().await
}

pub async fn session_reconcile(
    runtime: &Runtime,
    project_id: String,
) -> Result<SessionReconcileResult, String> {
    let _scan = lock_session_index(runtime, &project_id).await;
    let project = project::get(runtime, &project_id)?;
    if !project.default_workspace_pending() {
        let session_project =
            pi_workspace::resolve_session_project_with_paths(&runtime.paths, &project)?;
        // Connect outside the watcher registry lock; another project's scan must
        // not wait for a cold SSH/WSL connection. Register before taking the snapshot.
        let client = runtime.servers.client(&session_project.connection).await?;
        let _ = SessionWatcherManager::start(
            &runtime.session_watchers,
            runtime,
            &project,
            session_project,
            client,
        )
        .await;
    }
    reconcile_project_sessions(
        runtime,
        &project,
        SessionScanClient::Managed(&runtime.servers),
    )
    .await
}

/// Event-driven refresh: a live session watcher already keeps the index
/// current, so only an unwatched project (never started, failed or errored)
/// is scanned, which also restarts its watcher.
pub async fn session_refresh_unwatched(
    runtime: &Runtime,
    project_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    let project = project::get(runtime, &project_id)?;
    if !project.default_workspace_pending() {
        let session_project =
            pi_workspace::resolve_session_project_with_paths(&runtime.paths, &project)?;
        if runtime
            .session_watchers
            .lock()
            .await
            .covers(&session_project)
        {
            return session_list(runtime, project_id);
        }
    }
    Ok(session_reconcile(runtime, project_id).await?.sessions)
}

// Callers hold the project's index lock across the scan and commit.
pub(crate) async fn reconcile_project_sessions(
    runtime: &Runtime,
    project: &pilo_domain::Project,
    client: SessionScanClient<'_>,
) -> Result<SessionReconcileResult, String> {
    let work = session_index::reconcile(&runtime.paths, client, project).await?;
    if !work.deferred_paths.is_empty() {
        let should_start_background_index = {
            let mut manager = runtime
                .background_session_index
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            manager.enqueue(&project.id, work.deferred_paths)
        };
        if should_start_background_index {
            let background_events = runtime.events.clone();
            let background_runtime = runtime.downgrade();
            let background_manager = Arc::clone(&runtime.background_session_index);
            let background_project = project.clone();
            tokio::spawn(async move {
                let mut lease = BackgroundSessionIndexLease::new(
                    Arc::clone(&background_manager),
                    background_project.id.clone(),
                );
                let mut indexed_total = 0_usize;
                let mut failure = None;
                loop {
                    let batch = {
                        let mut manager = background_manager
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        manager.next_batch_or_finish(
                            &background_project.id,
                            session_index::BACKGROUND_SESSION_INDEX_BATCH,
                        )
                    };
                    let Some(batch) = batch else {
                        lease.disarm();
                        break;
                    };
                    let paths = batch
                        .iter()
                        .map(|(path, _)| path.clone())
                        .collect::<Vec<_>>();
                    let Ok(runtime) = background_runtime.upgrade() else {
                        break;
                    };
                    let _scan = lock_session_index(&runtime, &background_project.id).await;
                    let current_project = match project::get(&runtime, &background_project.id) {
                        Ok(project)
                            if project.connection.kind == background_project.connection.kind
                                && project.connection.pi_runtime
                                    == background_project.connection.pi_runtime
                                && project.path == background_project.path =>
                        {
                            project
                        }
                        _ => break,
                    };
                    let result = async {
                        let session_project = pi_workspace::resolve_session_project_with_paths(
                            &runtime.paths,
                            &current_project,
                        )?;
                        let client = runtime
                            .servers
                            .cached_client(&session_project.connection)
                            .await
                            .ok_or("pilo-server disconnected during background session indexing")?;
                        session_index::reconcile_paths(
                            &runtime.paths,
                            SessionScanClient::Existing(&client),
                            &current_project,
                            &paths,
                            &[],
                        )
                        .await
                    };
                    match result.await {
                        Ok(indexed) => {
                            indexed_total += indexed;
                            background_manager
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .complete_batch(&background_project.id, &batch);
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                    tokio::task::yield_now().await;
                }
                if indexed_total > 0 {
                    background_events.send(RuntimeEventEnvelope::global(
                        RuntimeEvent::SessionsIndexed {
                            project_id: background_project.id.clone(),
                        },
                    ));
                }
                if let Some(error) = failure {
                    background_events.send(RuntimeEventEnvelope::global(
                        RuntimeEvent::SessionIndexError {
                            project_id: background_project.id,
                            message: format!("background session indexing failed: {error}"),
                        },
                    ));
                }
            });
        }
    }
    Ok(work.result)
}
#[allow(clippy::too_many_arguments)]
pub async fn session_history(
    runtime: &Runtime,
    project_id: String,
    session_path: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
    start_message: Option<usize>,
    message_limit: Option<usize>,
    include_message_index: Option<bool>,
) -> Result<Vec<u8>, String> {
    let project = session_runtime_project(runtime, &project_id)?;
    let expected_fingerprint =
        expected_session_fingerprint(expected_file_size, expected_file_mtime_ns)?;
    let serialized = if let Some(message_limit) = message_limit {
        session_history::read_history_window_json(
            &runtime.servers,
            &runtime.session_history_cache,
            &project,
            &session_path,
            expected_fingerprint,
            start_message,
            message_limit,
            include_message_index.unwrap_or(false),
        )
        .await?
    } else {
        session_history::read_history_json(
            &runtime.servers,
            &runtime.session_history_cache,
            &project,
            &session_path,
            expected_fingerprint,
        )
        .await?
    };
    Ok(serialized)
}

pub async fn session_history_image(
    runtime: &Runtime,
    project_id: String,
    session_path: String,
    image_id: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
) -> Result<Vec<u8>, String> {
    let project = session_runtime_project(runtime, &project_id)?;
    let expected_fingerprint =
        expected_session_fingerprint(expected_file_size, expected_file_mtime_ns)?;
    let bytes = session_history::read_history_image_bytes(
        &runtime.servers,
        &runtime.session_history_cache,
        &project,
        &session_path,
        &image_id,
        expected_fingerprint,
    )
    .await?;
    Ok(bytes)
}

fn expected_session_fingerprint(
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
) -> Result<Option<(u64, u64)>, String> {
    let expected_file_mtime_ns = expected_file_mtime_ns
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("invalid expected session mtime '{value}': {error}"))
        })
        .transpose()?;
    Ok(expected_file_size.zip(expected_file_mtime_ns))
}

#[cfg(test)]
mod tests {
    #[test]
    fn history_fingerprint_accepts_complete_pairs_and_rejects_invalid_times() {
        assert_eq!(
            super::expected_session_fingerprint(Some(42), Some("99".into())).unwrap(),
            Some((42, 99))
        );
        assert_eq!(
            super::expected_session_fingerprint(None, None).unwrap(),
            None
        );
        assert_eq!(
            super::expected_session_fingerprint(Some(42), None).unwrap(),
            None
        );
        assert!(super::expected_session_fingerprint(Some(42), Some("invalid".into())).is_err());
    }

    use super::*;

    #[test]
    fn session_functions_preserve_cached_entries_and_ui_state_validation() {
        let root =
            std::env::temp_dir().join(format!("pilo-runtime-sessions-{}", std::process::id()));
        let runtime = Runtime::new(
            super::super::host_paths::HostPaths::new(root.clone(), root.join("resources")).unwrap(),
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
            &pilo_domain::Project {
                id: "project".into(),
                name: "project".into(),
                path: "/project".into(),
                connection,
                metadata: pilo_domain::ProjectMetadata {
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
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
