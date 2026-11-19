use std::sync::Arc;

use super::{RuntimeEventBus, host_events::HostEvents, host_paths::HostPaths};

#[derive(Clone)]
pub(crate) struct Runtime(Arc<RuntimeState>);

pub(crate) struct RuntimeState {
    pub(crate) paths: HostPaths,
    pub(crate) host_events: Arc<dyn HostEvents>,
    pub(crate) events: RuntimeEventBus,
    #[cfg(feature = "tauri")]
    pub(crate) core: super::PiloRuntime,
    #[cfg(feature = "tauri")]
    pub(crate) remote: super::RemoteServerManager,
}

#[cfg(feature = "tauri")]
impl std::ops::Deref for RuntimeState {
    type Target = super::PiloRuntime;

    fn deref(&self) -> &Self::Target {
        &self.core
    }
}

impl std::ops::Deref for Runtime {
    type Target = RuntimeState;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Runtime {
    pub(crate) fn new(paths: HostPaths, host_events: Arc<dyn HostEvents>) -> Self {
        let events = RuntimeEventBus::for_host();
        events.initialize_session_reads(paths.clone());
        Self(Arc::new(RuntimeState {
            paths,
            host_events,
            events,
            #[cfg(feature = "tauri")]
            core: super::PiloRuntime::default(),
            #[cfg(feature = "tauri")]
            remote: super::RemoteServerManager::default(),
        }))
    }
}

pub(crate) async fn session_read_states(
    runtime: &Runtime,
) -> Result<Vec<crate::domain::SessionReadState>, String> {
    let events = runtime.events.clone();
    tokio::task::spawn_blocking(move || events.session_read_states())
        .await
        .map_err(|error| format!("failed to load session read states: {error}"))?
}

pub(crate) async fn session_mark_read(
    runtime: &Runtime,
    project_id: String,
    session_path: String,
    revision: u64,
) -> Result<crate::domain::SessionReadState, String> {
    let events = runtime.events.clone();
    tokio::task::spawn_blocking(move || {
        events.mark_session_read(&project_id, &session_path, revision)
    })
    .await
    .map_err(|error| format!("failed to mark session read: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::super::host_events::RecordingEvents;
    use super::*;

    #[tokio::test]
    async fn cloned_runtime_shares_state_and_read_storage_without_a_shell() {
        let root = std::env::temp_dir().join(format!("pilo-runtime-handle-{}", std::process::id()));
        let paths = HostPaths::new(root.clone(), root.join("resources")).unwrap();
        let host = Arc::new(RecordingEvents::default());
        let runtime = Runtime::new(paths, host.clone());
        let cloned = runtime.clone();
        assert!(Arc::ptr_eq(&runtime.0, &cloned.0));
        assert!(session_read_states(&runtime).await.unwrap().is_empty());
        let db = super::super::storage::open(&runtime.paths).unwrap();
        let connection = super::super::storage::ensure_local_connection(&db).unwrap();
        super::super::storage::upsert_project(
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
        let completed =
            super::super::storage::complete_session_turn(&db, "project", "session").unwrap();
        let state = session_mark_read(
            &cloned,
            "project".into(),
            "session".into(),
            completed.completed_revision,
        )
        .await
        .unwrap();
        assert_eq!(session_read_states(&runtime).await.unwrap().len(), 1);
        assert_eq!(state.read_revision, completed.completed_revision);
        assert!(
            session_mark_read(&runtime, "".into(), "".into(), 0)
                .await
                .is_err()
        );
        runtime
            .host_events
            .emit("test", serde_json::Value::Null)
            .unwrap();
        assert_eq!(host.events.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
