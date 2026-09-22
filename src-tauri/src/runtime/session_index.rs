use std::collections::{BTreeMap, HashMap};

use pilo_protocol::SessionFile;
use serde_json::Value;
use tauri::AppHandle;

use crate::domain::{Project, SessionIndexEntry, SessionReconcileResult};

use super::{pi_workspace, server_client::ServerManager, storage};

const INITIAL_SESSION_INDEX_LIMIT: usize = 20;
pub const BACKGROUND_SESSION_INDEX_BATCH: usize = 64;

#[derive(Default)]
pub struct BackgroundSessionIndexManager {
    projects: HashMap<String, BackgroundSessionIndexProject>,
}

#[derive(Default)]
struct BackgroundSessionIndexProject {
    running: bool,
    generation: u64,
    pending_paths: BTreeMap<String, u64>,
}

impl BackgroundSessionIndexManager {
    pub fn enqueue(&mut self, project_id: &str, paths: Vec<String>) -> bool {
        if paths.is_empty() {
            return false;
        }
        let state = self.projects.entry(project_id.to_owned()).or_default();
        state.generation = state.generation.wrapping_add(1).max(1);
        let generation = state.generation;
        for path in paths {
            state.pending_paths.insert(path, generation);
        }
        if state.running {
            false
        } else {
            state.running = true;
            true
        }
    }

    pub fn next_batch_or_finish(
        &mut self,
        project_id: &str,
        limit: usize,
    ) -> Option<Vec<(String, u64)>> {
        let empty = self
            .projects
            .get(project_id)
            .is_none_or(|state| state.pending_paths.is_empty());
        if empty {
            self.projects.remove(project_id);
            return None;
        }
        let state = self.projects.get(project_id)?;
        Some(
            state
                .pending_paths
                .iter()
                .take(limit)
                .map(|(path, generation)| (path.clone(), *generation))
                .collect(),
        )
    }

    pub fn complete_batch(&mut self, project_id: &str, batch: &[(String, u64)]) {
        let Some(state) = self.projects.get_mut(project_id) else {
            return;
        };
        for (path, completed_generation) in batch {
            if state.pending_paths.get(path) == Some(completed_generation) {
                state.pending_paths.remove(path);
            }
        }
    }

    pub fn worker_aborted(&mut self, project_id: &str) {
        let remove = match self.projects.get_mut(project_id) {
            Some(state) => {
                state.running = false;
                state.pending_paths.is_empty()
            }
            None => false,
        };
        if remove {
            self.projects.remove(project_id);
        }
    }
}

#[derive(Debug)]
struct SessionFileMeta {
    path: String,
    size: u64,
    mtime_ns: u64,
    header: Value,
    unchanged: bool,
    deferred: bool,
    name: Option<String>,
    first_user_message_preview: Option<String>,
}

pub struct SessionReconcileWork {
    pub result: SessionReconcileResult,
    pub deferred_paths: Vec<String>,
}

pub fn list_cached(app: &AppHandle, project_id: &str) -> Result<Vec<SessionIndexEntry>, String> {
    storage::list_sessions(&storage::open(app)?, project_id)
}

pub async fn reconcile(
    app: &AppHandle,
    servers: &ServerManager,
    project: &Project,
) -> Result<SessionReconcileWork, String> {
    let session_project = pi_workspace::resolve_session_project(app, project)?;
    let mut db = storage::open(app)?;
    let cached = storage::list_sessions(&db, &project.id)?;
    let files = scan_files(
        servers,
        &session_project,
        &cached,
        Some(INITIAL_SESSION_INDEX_LIMIT),
        &[],
    )
    .await?;
    let cached_by_path = cached
        .iter()
        .map(|session| (session.session_path.as_str(), session))
        .collect::<std::collections::HashMap<_, _>>();
    let mut result = SessionReconcileResult::default();
    let mut seen = Vec::with_capacity(files.len());
    let mut deferred_paths = Vec::new();
    let transaction = db.transaction().map_err(|error| error.to_string())?;

    for file in files {
        let previous = cached_by_path.get(file.path.as_str()).copied();
        if file.unchanged {
            if previous.is_some() {
                seen.push(file.path);
                result.unchanged += 1;
            }
            continue;
        }
        if file.deferred {
            seen.push(file.path.clone());
            deferred_paths.push(file.path);
            continue;
        }
        if file.header.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        if file.header.get("cwd").and_then(Value::as_str) != Some(session_project.path.as_str()) {
            continue;
        }

        seen.push(file.path.clone());
        let entry = build_index_entry(project, file, previous)?;
        storage::upsert_session(&transaction, &entry)?;
        if previous.is_some() {
            result.updated += 1;
        } else {
            result.added += 1;
        }
    }

    result.removed = storage::remove_missing_sessions(&transaction, &project.id, &seen)?;
    transaction.commit().map_err(|error| error.to_string())?;
    result.sessions = storage::list_sessions(&db, &project.id)?;
    Ok(SessionReconcileWork {
        result,
        deferred_paths,
    })
}

pub async fn index_paths(
    app: &AppHandle,
    servers: &ServerManager,
    project: &Project,
    paths: &[String],
) -> Result<usize, String> {
    reconcile_paths(app, servers, project, paths, &[]).await
}

pub async fn reconcile_paths(
    app: &AppHandle,
    servers: &ServerManager,
    project: &Project,
    paths: &[String],
    removed_paths: &[String],
) -> Result<usize, String> {
    if paths.is_empty() && removed_paths.is_empty() {
        return Ok(0);
    }
    let session_project = pi_workspace::resolve_session_project(app, project)?;
    let files = scan_files(servers, &session_project, &[], None, paths).await?;
    let mut db = storage::open(app)?;
    let transaction = db.transaction().map_err(|error| error.to_string())?;
    let mut changed = 0_usize;
    for path in removed_paths {
        if storage::remove_session_for_project(&transaction, &project.id, path)? {
            changed += 1;
        }
    }
    for file in files {
        if file.unchanged || file.deferred {
            continue;
        }
        if file.header.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        if file.header.get("cwd").and_then(Value::as_str) != Some(session_project.path.as_str()) {
            continue;
        }
        let previous = storage::get_session(&transaction, &file.path)?;
        let entry = build_index_entry(project, file, previous.as_ref())?;
        storage::upsert_session(&transaction, &entry)?;
        changed += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

async fn scan_files(
    servers: &ServerManager,
    project: &Project,
    cached: &[SessionIndexEntry],
    summary_limit: Option<usize>,
    paths: &[String],
) -> Result<Vec<SessionFileMeta>, String> {
    let known = cached
        .iter()
        .map(|session| {
            serde_json::json!({
                "path": session.session_path,
                "size": session.file_size,
                "mtimeNs": session.file_mtime_ns,
            })
        })
        .collect::<Vec<_>>();
    let files: Vec<SessionFile> = servers
        .request_typed(
            &project.connection,
            "session.scan",
            serde_json::json!({
                "project": project.path,
                "known": known,
                "summaryLimit": summary_limit,
                "paths": paths,
            }),
        )
        .await?;
    Ok(files
        .into_iter()
        .map(|file| SessionFileMeta {
            path: file.path,
            size: file.size,
            mtime_ns: file.mtime_ns,
            header: file.header,
            unchanged: file.unchanged,
            deferred: file.deferred,
            name: file.name,
            first_user_message_preview: file.first_user_message_preview,
        })
        .collect())
}

fn build_index_entry(
    project: &Project,
    file: SessionFileMeta,
    previous: Option<&SessionIndexEntry>,
) -> Result<SessionIndexEntry, String> {
    let pi_session_id = file
        .header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("session '{}' has no id", file.path))?
        .to_owned();
    // Local-Pi SSH sessions are stored under a local anchor directory, but
    // the indexed workspace identity remains the authoritative remote cwd.
    let cwd = project.path.clone();
    let created_at = file
        .header
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    Ok(SessionIndexEntry {
        connection_id: project.connection.id.clone(),
        project_id: project.id.clone(),
        pi_session_id,
        session_path: file.path,
        name: file
            .name
            .or_else(|| previous.and_then(|value| value.name.clone())),
        cwd,
        created_at: created_at.clone(),
        updated_at: previous
            .map(|value| value.updated_at.clone())
            .unwrap_or(created_at),
        message_count: previous.map(|value| value.message_count).unwrap_or(0),
        last_message_at: previous.and_then(|value| value.last_message_at.clone()),
        first_user_message_preview: file
            .first_user_message_preview
            .or_else(|| previous.and_then(|value| value.first_user_message_preview.clone())),
        file_size: file.size,
        file_mtime_ns: file.mtime_ns,
        // Session list indexing is intentionally lightweight. The full file is parsed only when
        // the user opens the session, so the index marks the current file size as observed rather
        // than maintaining a full-parser cursor here.
        last_offset: file.size,
        indexed_at_ms: storage::now_ms(),
        pinned: previous.is_some_and(|value| value.pinned),
        title_override: previous.and_then(|value| value.title_override.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Connection, ConnectionKind, ProjectMetadata};

    fn test_project() -> Project {
        Project {
            id: "project:local:/work".to_owned(),
            name: "work".to_owned(),
            path: "/work".to_owned(),
            connection: Connection {
                id: "local".to_owned(),
                name: "Local".to_owned(),
                pi_executable: None,
                pi_runtime: crate::domain::PiRuntime::default(),
                kind: ConnectionKind::Local,
            },
            metadata: ProjectMetadata {
                cwd: "/work".to_owned(),
                git_branch: Some("main".to_owned()),
                pi_version: "1.0.0".to_owned(),
                refreshed_at_ms: 1,
            },
            created_at_ms: 1,
            last_opened_at_ms: 1,
        }
    }

    #[test]
    fn lightweight_index_uses_scan_summary_without_parsing_session_body() {
        let project = test_project();
        let entry = build_index_entry(
            &project,
            SessionFileMeta {
                path: "/sessions/a.jsonl".to_owned(),
                size: 500 * 1024 * 1024,
                mtime_ns: 42,
                header: serde_json::json!({
                    "type": "session",
                    "id": "session-a",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "cwd": "/work"
                }),
                unchanged: false,
                deferred: false,
                name: Some("Indexed name".to_owned()),
                first_user_message_preview: Some("hello world".to_owned()),
            },
            None,
        )
        .unwrap();

        assert_eq!(entry.name.as_deref(), Some("Indexed name"));
        assert_eq!(
            entry.first_user_message_preview.as_deref(),
            Some("hello world")
        );
        assert_eq!(entry.message_count, 0);
        assert_eq!(entry.last_message_at, None);
        assert_eq!(entry.last_offset, entry.file_size);
    }

    #[test]
    fn lightweight_index_preserves_cached_summary_when_scan_has_no_new_summary() {
        let project = test_project();
        let previous = SessionIndexEntry {
            connection_id: "local".to_owned(),
            project_id: project.id.clone(),
            pi_session_id: "session-a".to_owned(),
            session_path: "/sessions/a.jsonl".to_owned(),
            name: Some("Existing name".to_owned()),
            cwd: "/work".to_owned(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            message_count: 99,
            last_message_at: Some("2026-01-01T01:00:00.000Z".to_owned()),
            first_user_message_preview: Some("existing preview".to_owned()),
            file_size: 100,
            file_mtime_ns: 1,
            last_offset: 100,
            indexed_at_ms: 1,
            pinned: true,
            title_override: None,
        };
        let entry = build_index_entry(
            &project,
            SessionFileMeta {
                path: previous.session_path.clone(),
                size: 200,
                mtime_ns: 2,
                header: serde_json::json!({
                    "type": "session",
                    "id": "session-a",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "cwd": "/work"
                }),
                unchanged: false,
                deferred: false,
                name: None,
                first_user_message_preview: None,
            },
            Some(&previous),
        )
        .unwrap();

        assert_eq!(entry.name, previous.name);
        assert_eq!(
            entry.first_user_message_preview,
            previous.first_user_message_preview
        );
        assert_eq!(entry.message_count, previous.message_count);
        assert_eq!(entry.last_message_at, previous.last_message_at);
        assert_eq!(entry.last_offset, 200);
        assert!(entry.pinned);
    }

    #[test]
    fn background_index_manager_merges_pending_paths_without_starting_a_second_worker() {
        let mut manager = BackgroundSessionIndexManager::default();
        assert!(manager.enqueue("project", vec!["b".to_owned(), "a".to_owned()]));
        assert!(!manager.enqueue("project", vec!["c".to_owned()]));

        let first = manager.next_batch_or_finish("project", 2).unwrap();
        assert_eq!(
            first
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );

        assert!(!manager.enqueue("project", vec!["a".to_owned()]));
        manager.complete_batch("project", &first);
        let second = manager.next_batch_or_finish("project", 8).unwrap();
        assert_eq!(
            second
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c"]
        );
        manager.complete_batch("project", &second);
        assert!(manager.next_batch_or_finish("project", 8).is_none());
    }

    #[test]
    fn background_index_manager_keeps_inflight_paths_after_worker_abort() {
        let mut manager = BackgroundSessionIndexManager::default();
        assert!(manager.enqueue("project", vec!["a".to_owned()]));
        let first = manager.next_batch_or_finish("project", 8).unwrap();
        assert_eq!(first[0].0, "a");

        manager.worker_aborted("project");
        assert!(manager.enqueue("project", vec!["b".to_owned()]));
        let retried = manager.next_batch_or_finish("project", 8).unwrap();
        assert_eq!(
            retried
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }
}
