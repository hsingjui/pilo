use std::sync::{Arc, OnceLock, Weak};

use super::{RuntimeEventBus, host_events::HostEvents, host_paths::HostPaths};

pub trait HostShell: Send + Sync {
    fn cache_dir(&self) -> Result<std::path::PathBuf, String>;
    fn open_path(&self, path: &std::path::Path) -> Result<(), String>;
    fn pick_directory(&self) -> Option<String>;
    fn desktop_setting(
        &self,
        _key: String,
        _value: Option<serde_json::Value>,
    ) -> HostSettingFuture {
        Box::pin(async { Err("host desktop settings are unavailable".to_owned()) })
    }
}

pub type HostSettingFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<serde_json::Value, String>> + Send>>;

#[derive(Clone, Default)]
pub(crate) struct WeakRuntime(Weak<RuntimeState>);

impl WeakRuntime {
    pub(crate) fn upgrade(&self) -> Result<Runtime, String> {
        self.0
            .upgrade()
            .map(Runtime)
            .ok_or_else(|| "Pilo Host control is unavailable".to_owned())
    }
}

#[derive(Clone)]
pub struct Runtime(Arc<RuntimeState>);

pub struct RuntimeState {
    pub(crate) paths: HostPaths,
    pub(crate) host_events: Arc<dyn HostEvents>,
    pub(crate) events: RuntimeEventBus,
    shell: OnceLock<Arc<dyn HostShell>>,
    web_assets: OnceLock<Arc<dyn super::web_assets::WebAssets>>,
    pub(crate) core: super::PiloRuntime,
    pub(crate) remote: super::RemoteServerManager,
}

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
    pub fn new(paths: HostPaths, host_events: Arc<dyn HostEvents>) -> Self {
        let events = RuntimeEventBus::for_host();
        events.initialize_session_reads(paths.clone());
        let runtime = Self(Arc::new(RuntimeState {
            paths,
            host_events,
            events,
            shell: OnceLock::new(),
            web_assets: OnceLock::new(),
            core: super::PiloRuntime::default(),
            remote: super::RemoteServerManager::default(),
        }));
        runtime.servers.initialize_control(&runtime);
        runtime
    }

    pub fn with_shell(self, shell: Arc<dyn HostShell>) -> Result<Self, String> {
        if Arc::strong_count(&self.0) != 1 {
            return Err("runtime is already shared".to_owned());
        }
        self.shell
            .set(shell)
            .map_err(|_| "host shell is already configured")?;
        Ok(self)
    }

    pub(crate) fn shell(&self) -> Result<&dyn HostShell, String> {
        self.shell
            .get()
            .map(Arc::as_ref)
            .ok_or_else(|| "host shell services are unavailable".to_owned())
    }

    pub fn start_external_activity_poll(&self) {
        self.events.start_external_activity_poll(self.clone());
    }

    pub fn start_idle_reaper(&self) {
        self.chat_sessions.start_idle_reaper();
    }

    pub async fn restore_remote(&self) -> Result<(), String> {
        self.remote.restore(self).await
    }

    pub async fn shutdown(&self) {
        self.servers.begin_shutdown();
        let teardown = async {
            log::info!(target: "shutdown", "remote webui: stopping");
            self.remote.stop().await;
            log::info!(target: "shutdown", "chat sessions: stopping");
            self.chat_sessions.stop_all().await;
            log::info!(target: "shutdown", "project pi session: stopping");
            let _ = self.project_pi_session.lock().await.stop().await;
            log::info!(target: "shutdown", "session watchers: stopping");
            self.session_watchers.lock().await.stop_all().await;
            log::info!(target: "shutdown", "terminals: closing");
            self.terminals.lock().await.close_all().await;
        };
        if tokio::time::timeout(std::time::Duration::from_secs(5), teardown)
            .await
            .is_err()
        {
            log::warn!(target: "shutdown", "graceful shutdown timed out; stopping servers");
        }
        // Always close server stdin, even when chat/terminal cleanup timed out.
        log::info!(target: "shutdown", "servers: stopping");
        if tokio::time::timeout(std::time::Duration::from_secs(8), self.servers.stop_all())
            .await
            .is_err()
        {
            log::warn!(target: "shutdown", "server cleanup timed out; exiting");
        }
        log::info!(target: "shutdown", "teardown complete");
    }

    pub(crate) fn downgrade(&self) -> WeakRuntime {
        WeakRuntime(Arc::downgrade(&self.0))
    }

    pub fn with_web_assets(
        self,
        assets: Arc<dyn super::web_assets::WebAssets>,
    ) -> Result<Self, String> {
        self.web_assets
            .set(assets)
            .map_err(|_| "web assets are already configured")?;
        Ok(self)
    }

    pub(crate) fn web_assets(&self) -> Option<&dyn super::web_assets::WebAssets> {
        self.web_assets.get().map(Arc::as_ref)
    }
}

pub async fn session_read_states(
    runtime: &Runtime,
) -> Result<Vec<crate::domain::SessionReadState>, String> {
    let events = runtime.events.clone();
    tokio::task::spawn_blocking(move || events.session_read_states())
        .await
        .map_err(|error| format!("failed to load session read states: {error}"))?
}

pub fn runtime_subscribe_events(
    runtime: &Runtime,
    window_label: &str,
    channel_id: u32,
    events: Arc<dyn HostEvents>,
) {
    runtime.events.subscribe(window_label, channel_id, events);
}

pub async fn session_mark_read(
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
    async fn agent_control_resolves_the_same_runtime_without_retaining_it() {
        let runtime = Runtime::new(
            HostPaths::for_test(std::path::PathBuf::new()),
            Arc::new(RecordingEvents::default()),
        );
        let servers = runtime.servers.clone();
        let shared = servers.control_runtime().unwrap();
        assert!(Arc::ptr_eq(&runtime.0, &shared.0));
        let weak = runtime.downgrade();
        drop(shared);
        drop(runtime);
        assert!(weak.upgrade().is_err());
        assert!(servers.control_runtime().is_err());
        assert!(
            super::super::server_client::ServerManager::default()
                .control_runtime()
                .is_err()
        );
    }

    #[tokio::test]
    async fn empty_runtime_shutdown_revokes_control_and_is_repeatable() {
        let runtime = Runtime::new(
            HostPaths::for_test(std::path::PathBuf::new()),
            Arc::new(RecordingEvents::default()),
        );
        assert!(runtime.servers.control_runtime().is_ok());
        runtime.shutdown().await;
        assert!(runtime.servers.control_runtime().is_err());
        runtime.shutdown().await;
    }

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
        runtime_subscribe_events(&runtime, "main", 1, host.clone());
        runtime
            .events
            .send(super::super::events::RuntimeEventEnvelope::global(
                super::super::events::RuntimeEvent::PreferencesChanged {
                    settings: super::super::preferences::preferences_get(&runtime).unwrap(),
                },
            ));
        let recorded = host.events.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[1].0, super::super::events::RUNTIME_EVENT_NAME);
        drop(recorded);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
