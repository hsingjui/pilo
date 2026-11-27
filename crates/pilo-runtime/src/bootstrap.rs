use std::collections::HashMap;

use serde::Serialize;

use super::{
    Runtime, chat_sessions::ChatSessionState, preferences::PreferencesSnapshot, project, storage,
};

/// State read after the event cut, not an atomic cross-service snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub event_sequence: u64,
    pub projects: Vec<pilo_domain::Project>,
    pub chat_sessions: Vec<ChatSessionState>,
    pub preferences: PreferencesSnapshot,
}

impl Runtime {
    /// Subscribe first so events arriving during snapshot reads remain queued.
    /// This cut is not a transcript watermark and must not suppress session deltas.
    pub async fn bootstrap_snapshot(&self) -> Result<BootstrapSnapshot, String> {
        let snapshot = load(self, true, false, false).await?;
        Ok(BootstrapSnapshot {
            event_sequence: snapshot.event_sequence,
            projects: snapshot.projects,
            chat_sessions: snapshot.chat_sessions,
            preferences: snapshot.preferences.expect("preferences were requested"),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostBootstrap {
    event_sequence: u64,
    projects: Vec<pilo_domain::Project>,
    chat_sessions: Vec<ChatSessionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preferences: Option<PreferencesSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_pi_resources: Option<HashMap<String, bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ui_state: Option<BootstrapUiState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapUiState {
    theme_settings: pilo_domain::ThemeSettings,
    session_read_states: Vec<pilo_domain::SessionReadState>,
}

pub(crate) async fn load(
    runtime: &Runtime,
    include_preferences: bool,
    include_ui_state: bool,
    include_local_pi_resources: bool,
) -> Result<HostBootstrap, String> {
    let event_sequence = runtime.events.snapshot_sequence();
    let rt = runtime.clone();
    let (projects, preferences, ui_state, local_pi_resources) =
        tokio::task::spawn_blocking(move || {
            let projects = project::list(&rt)?;
            let db = storage::open(&rt.paths)?;
            let preferences = include_preferences
                .then(|| storage::get_preferences(&db))
                .transpose()?;
            let ui_state = include_ui_state
                .then(|| {
                    Ok::<_, String>(BootstrapUiState {
                        theme_settings: storage::get_theme_settings(&db)?,
                        session_read_states: storage::list_session_read_states(&db)?,
                    })
                })
                .transpose()?;
            let local_pi_resources = include_local_pi_resources
                .then(|| local_pi_resources_snapshot(&db))
                .transpose()?;
            Ok::<_, String>((projects, preferences, ui_state, local_pi_resources))
        })
        .await
        .map_err(|error| format!("bootstrap task failed: {error}"))??;
    Ok(HostBootstrap {
        event_sequence,
        projects,
        chat_sessions: runtime.chat_sessions.states().await,
        preferences,
        local_pi_resources,
        ui_state,
    })
}

fn local_pi_resources_snapshot(db: &rusqlite::Connection) -> Result<HashMap<String, bool>, String> {
    let mut statement = db
        .prepare(
            "SELECT id, kind_json, local_pi_resources FROM connections WHERE pi_runtime='local'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut result = HashMap::new();
    for row in rows {
        let (id, kind_json, enabled) = row.map_err(|error| error.to_string())?;
        if let Ok(pilo_domain::ConnectionKind::Ssh { .. }) =
            serde_json::from_str::<pilo_domain::ConnectionKind>(&kind_json)
        {
            result.insert(id, enabled);
        }
    }
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        events::{
            EventBatch, EventQueueLimits, RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope,
        },
        host_paths::HostPaths,
    };
    use std::{
        path::PathBuf,
        sync::{
            Arc, OnceLock,
            atomic::{AtomicUsize, Ordering},
        },
    };

    pub(crate) fn runtime_with_mid_snapshot_change(label: &str) -> (Runtime, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "pilo-bootstrap-{label}-{}-{}",
            std::process::id(),
            storage::now_ms()
        ));
        let directory = root.clone();
        let events = Arc::new(OnceLock::<RuntimeEventBus>::new());
        let bus = Arc::clone(&events);
        let reads = AtomicUsize::new(0);
        let paths = HostPaths::with_data_dir_resolver(PathBuf::new(), move || {
            let read = reads.fetch_add(1, Ordering::SeqCst);
            if read == 1 {
                let db = storage::open_with_paths(&HostPaths::for_test(directory.clone())).unwrap();
                db.execute_batch("INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
                    VALUES('changed','local','changed','/changed','{\"cwd\":\"/changed\",\"gitBranch\":null,\"piVersion\":\"test\",\"refreshedAtMs\":0}',0,0);").unwrap();
            }
            if read <= 1 {
                bus.get().unwrap().send(RuntimeEventEnvelope::global(
                    RuntimeEvent::ConfigurationChanged,
                ));
            }
            Ok(directory.clone())
        });
        let runtime = Runtime::new(paths);
        assert!(events.set(runtime.events.clone()).is_ok());
        runtime.events.send(RuntimeEventEnvelope::global(
            RuntimeEvent::ConfigurationChanged,
        ));
        (runtime, root)
    }

    #[tokio::test]
    async fn cut_precedes_first_snapshot_read_and_keeps_a_later_change_in_events() {
        let (runtime, root) = runtime_with_mid_snapshot_change("runtime-cut");
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 10,
            max_bytes: 4096,
        });
        let snapshot = runtime.bootstrap_snapshot().await.unwrap();
        assert_eq!(snapshot.event_sequence, 1);
        assert!(
            !snapshot
                .projects
                .iter()
                .any(|project| project.id == "changed")
        );
        assert!(
            project::list(&runtime)
                .unwrap()
                .iter()
                .any(|project| project.id == "changed")
        );
        let EventBatch::Events(events) = stream.try_next_batch(10).unwrap() else {
            panic!("expected events after cut")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(serde_json::to_value(&snapshot).unwrap()["eventSequence"], 1);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn empty_store_returns_default_state_and_zero_cut() {
        let root = std::env::temp_dir().join(format!(
            "pilo-bootstrap-empty-{}-{}",
            std::process::id(),
            storage::now_ms()
        ));
        let runtime = Runtime::new(HostPaths::for_test(root.clone()));
        let snapshot = runtime.bootstrap_snapshot().await.unwrap();
        assert_eq!(snapshot.event_sequence, 0);
        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.chat_sessions.is_empty());
        assert_eq!(snapshot.preferences.revision, 0);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn bootstrap_propagates_storage_errors() {
        let paths =
            HostPaths::with_data_dir_resolver(PathBuf::new(), || Err("data unavailable".into()));
        let runtime = Runtime::new(paths);
        assert!(
            matches!(runtime.bootstrap_snapshot().await, Err(error) if error == "data unavailable")
        );
    }
}
