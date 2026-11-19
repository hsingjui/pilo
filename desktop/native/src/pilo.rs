use std::{
    future::Future,
    path::{Component, Path, PathBuf},
    sync::{Arc, OnceLock},
};

use nsh_core::{JsonValue, prelude::*};
use pilo_lib::{
    domain::SessionReadState,
    initialize_local_server_binary,
    runtime::{
        Runtime,
        handle::{session_mark_read, session_read_states},
        host_events::HostEvents,
        host_paths::HostPaths,
        initialize_server_resource_dir,
        preferences::{PreferencesSnapshot, preferences_get, preferences_patch},
        project_api::project_list,
        runtime_api::chat_session_states,
        session_api::session_reconcile,
        tasks,
        web_assets::{WebAsset, WebAssets},
    },
};
use serde::Serialize;
use tokio::{runtime::Runtime as Executor, sync::Mutex};

const CLOSED: &str = "Pilo runtime has been shut down";

struct ShellEvents;

impl HostEvents for ShellEvents {
    fn emit(&self, _name: &str, _payload: JsonValue) -> Result<(), String> {
        Ok(())
    }
}

struct ShellWebAssets(PathBuf);

impl WebAssets for ShellWebAssets {
    fn get(&self, path: &str) -> Option<WebAsset> {
        let path = Path::new(path);
        if !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return None;
        }
        let root = self.0.canonicalize().ok()?;
        let file = root.join(path).canonicalize().ok()?;
        if !file.starts_with(root) || !file.is_file() {
            return None;
        }
        Some(WebAsset {
            bytes: std::fs::read(file).ok()?,
            mime_type: mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string(),
        })
    }
}

fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn default_data_dir(home: &Path, development: bool) -> PathBuf {
    home.join("Library/Application Support")
        .join(if development {
            "app.hsingjui.pilo.dev"
        } else {
            "app.hsingjui.pilo"
        })
}

fn executor() -> Result<&'static Executor, String> {
    static EXECUTOR: OnceLock<Result<Executor, String>> = OnceLock::new();
    EXECUTOR
        .get_or_init(|| {
            let executor = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("pilo-runtime")
                .build()
                .map_err(|error| format!("failed to start the Pilo executor: {error}"))?;
            tasks::initialize(executor.handle().clone());
            Ok(executor)
        })
        .as_ref()
        .map_err(Clone::clone)
}

type Host = Arc<Mutex<Option<Runtime>>>;

async fn stop_host(host: Host) {
    let mut host = host.lock().await;
    if let Some(runtime) = host.take() {
        runtime.shutdown().await;
    }
}

async fn run_with_runtime<T, F>(
    host: Host,
    operation: impl FnOnce(Runtime) -> F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let runtime = host.lock().await.as_ref().ok_or(CLOSED)?.clone();
    operation(runtime).await
}

fn encode_list(values: Vec<impl Serialize>) -> Result<Vec<JsonValue>, String> {
    values
        .into_iter()
        .map(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        .collect()
}

fn load_projects(runtime: &Runtime) -> Result<Vec<JsonValue>, String> {
    encode_list(project_list(runtime)?)
}

/// The initial project catalog and runtime snapshots. The event cursor is not yet available.
#[derive(JsObject)]
pub struct Bootstrap {
    /// Projects with their saved connection and metadata.
    pub projects: Vec<JsonValue>,
    /// Snapshots of chat sessions currently held by the runtime.
    pub chat_sessions: Vec<JsonValue>,
}

/// The current revision and complete Host preference values.
#[derive(JsObject)]
pub struct NativePreferencesSnapshot {
    pub revision: u64,
    pub values: JsonValue,
}

impl From<PreferencesSnapshot> for NativePreferencesSnapshot {
    fn from(snapshot: PreferencesSnapshot) -> Self {
        Self {
            revision: snapshot.revision,
            values: JsonValue::Object(snapshot.values),
        }
    }
}

/// The completed and acknowledged revisions for a saved session.
#[derive(JsObject)]
pub struct NativeSessionReadState {
    pub project_id: String,
    pub session_path: String,
    pub completed_revision: u64,
    pub read_revision: u64,
}

impl From<SessionReadState> for NativeSessionReadState {
    fn from(state: SessionReadState) -> Self {
        Self {
            project_id: state.project_id,
            session_path: state.session_path,
            completed_revision: state.completed_revision,
            read_revision: state.read_revision,
        }
    }
}

/// A native host for the shared Pilo runtime.
#[class]
pub struct Pilo {
    host: Host,
    executor: &'static Executor,
}

impl Pilo {
    async fn load_bootstrap(host: Host) -> Result<Bootstrap, String> {
        let host = host.lock().await;
        let runtime = host.as_ref().ok_or(CLOSED)?;
        let project_runtime = runtime.clone();
        let projects = tokio::task::spawn_blocking(move || load_projects(&project_runtime))
            .await
            .map_err(|error| format!("failed to load projects: {error}"))??;
        Ok(Bootstrap {
            projects,
            chat_sessions: encode_list(chat_session_states(runtime).await?)?,
        })
    }

    async fn with_runtime<T, F>(
        this: Instance<Self>,
        operation: impl FnOnce(Runtime) -> F + Send + 'static,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let task = this.with(|pilo| {
            let host = pilo.host.clone();
            pilo.executor.spawn(run_with_runtime(host, operation))
        });
        task.await
            .map_err(|error| format!("Pilo runtime task failed: {error}"))?
    }

    async fn with_runtime_blocking<T: Send + 'static>(
        this: Instance<Self>,
        operation: impl FnOnce(&Runtime) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        Self::with_runtime(this, move |runtime| async move {
            tokio::task::spawn_blocking(move || operation(&runtime))
                .await
                .map_err(|error| format!("Pilo runtime task failed: {error}"))?
        })
        .await
    }
}

#[class]
impl Pilo {
    /// Opens Pilo on the existing macOS Tauri data directory, or an explicit absolute directory.
    pub fn new(data_dir: Option<String>) -> Result<Self, String> {
        let data_dir = match data_dir {
            Some(path) => PathBuf::from(path),
            None => {
                let home = std::env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .ok_or("could not find the Pilo data directory: HOME is unavailable")?;
                default_data_dir(Path::new(&home), cfg!(debug_assertions))
            }
        };
        if !data_dir.is_absolute() {
            return Err("Pilo data directory must be an absolute path".into());
        }

        let resources = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|dir| dir.join("../Resources")))
            .ok_or("could not locate Pilo application resources")?;
        let paths = HostPaths::new(data_dir, resources.clone())?;
        let executor = executor()?;
        let workspace = workspace();
        let web_root = if cfg!(debug_assertions) {
            workspace.join("dist")
        } else {
            resources.join("webui")
        };
        let server = std::env::var_os("PILO_SERVER_BINARY")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(debug_assertions) {
                    let target = format!("{}-apple-darwin", std::env::consts::ARCH);
                    let binary = workspace
                        .join("target")
                        .join(target)
                        .join("debug/pilo-server");
                    if binary.is_file() {
                        binary
                    } else {
                        workspace.join("target/debug/pilo-server")
                    }
                } else {
                    resources.join("runtime/pilo-server-darwin-aarch64")
                }
            });
        initialize_server_resource_dir(resources);
        initialize_local_server_binary(server);
        let runtime = Runtime::new(paths, Arc::new(ShellEvents))
            .with_web_assets(Arc::new(ShellWebAssets(web_root)))?;
        runtime.start_idle_reaper();
        Ok(Self {
            host: Arc::new(Mutex::new(Some(runtime))),
            executor,
        })
    }

    /// Reads the saved project catalog and live chat snapshots.
    pub async fn bootstrap(this: Instance<Self>) -> Result<Bootstrap, String> {
        let task = this.with(|pilo| pilo.executor.spawn(Self::load_bootstrap(pilo.host.clone())));
        task.await
            .map_err(|error| format!("failed to bootstrap Pilo: {error}"))?
    }

    /// Reads the saved project catalog without loading live chat snapshots.
    pub async fn list_projects(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime_blocking(this, load_projects).await
    }

    /// Reconciles the project's session index and returns its saved sessions.
    pub async fn list_sessions(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        let task = this.with(|pilo| {
            let host = pilo.host.clone();
            pilo.executor
                .spawn(run_with_runtime(host, move |runtime| async move {
                    encode_list(session_reconcile(&runtime, project_id).await?.sessions)
                }))
        });
        task.await
            .map_err(|error| format!("failed to load sessions: {error}"))?
    }

    /// Loads the persisted read states across projects.
    pub async fn load_session_read_states(
        this: Instance<Self>,
    ) -> Result<Vec<NativeSessionReadState>, String> {
        Self::with_runtime(this, |runtime| async move {
            Ok(session_read_states(&runtime)
                .await?
                .into_iter()
                .map(Into::into)
                .collect())
        })
        .await
    }

    /// Acknowledges an observed session revision and returns the resulting read state.
    pub async fn mark_session_read(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
        revision: f64,
    ) -> Result<NativeSessionReadState, String> {
        Self::with_runtime(this, move |runtime| async move {
            if !(1.0..=9_007_199_254_740_991.0).contains(&revision) || revision.fract() != 0.0 {
                return Err("session read revision must be a positive safe integer".into());
            }
            session_mark_read(&runtime, project_id, session_path, revision as u64)
                .await
                .map(Into::into)
        })
        .await
    }

    /// Reads the complete Host preferences from the runtime's SQLite index.
    pub async fn load_preferences(
        this: Instance<Self>,
    ) -> Result<NativePreferencesSnapshot, String> {
        Self::with_runtime_blocking(this, |runtime| preferences_get(runtime).map(Into::into)).await
    }

    /// Applies a partial patch and returns the complete, updated preferences.
    pub async fn save_preferences(
        this: Instance<Self>,
        patch: JsonValue,
    ) -> Result<NativePreferencesSnapshot, String> {
        Self::with_runtime_blocking(this, |runtime| {
            let JsonValue::Object(patch) = patch else {
                return Err("Pilo preference patch must be an object".into());
            };
            preferences_patch(runtime, patch, None).map(Into::into)
        })
        .await
    }

    /// Waits for the runtime to close. Safe to call again after shutdown.
    pub async fn shutdown(this: Instance<Self>) -> Result<(), String> {
        let task = this.with(|pilo| pilo.executor.spawn(stop_host(pilo.host.clone())));
        task.await
            .map_err(|error| format!("failed to shut down Pilo: {error}"))
    }
}

impl Drop for Pilo {
    fn drop(&mut self) {
        self.executor.spawn(stop_host(self.host.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pilo_lib::{
        domain::{Project, ProjectMetadata},
        runtime::storage,
    };

    #[test]
    fn uses_tauri_data_locations() {
        let home = Path::new("/Users/example");
        for (development, config, identifier) in [
            (
                false,
                include_str!("../../../src-tauri/tauri.conf.json"),
                "app.hsingjui.pilo",
            ),
            (
                true,
                include_str!("../../../src-tauri/tauri.dev.conf.json"),
                "app.hsingjui.pilo.dev",
            ),
        ] {
            let tauri: JsonValue = serde_json::from_str(config).unwrap();
            assert_eq!(tauri["identifier"], identifier);
            assert_eq!(
                default_data_dir(home, development),
                home.join("Library/Application Support").join(identifier)
            );
        }
    }

    #[test]
    fn disconnected_shell_discards_host_events_without_error() {
        assert!(
            ShellEvents
                .emit("pilo://session-watch", JsonValue::Null)
                .is_ok()
        );
    }

    #[test]
    fn bootstrap_reads_existing_projects_and_shutdown_closes_the_handle() {
        let data = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(data.path().into(), data.path().into()).unwrap();
        let db = storage::open(&paths).unwrap();
        let project = Project {
            id: "saved-project".into(),
            name: "Saved project".into(),
            path: "/projects/saved".into(),
            connection: storage::ensure_local_connection(&db).unwrap(),
            metadata: ProjectMetadata {
                cwd: "/projects/saved".into(),
                git_branch: Some("main".into()),
                pi_version: "test".into(),
                refreshed_at_ms: 2,
            },
            created_at_ms: 1,
            last_opened_at_ms: 3,
        };
        storage::upsert_project(&db, &project).unwrap();
        drop(db);

        let pilo = Pilo::new(Some(data.path().to_str().unwrap().into())).unwrap();
        pilo.executor.block_on(async {
            let initial = Pilo::load_bootstrap(pilo.host.clone()).await.unwrap();
            let saved = initial
                .projects
                .iter()
                .find(|item| item["id"] == project.id)
                .unwrap();
            assert_eq!(saved, &serde_json::to_value(project).unwrap());
            assert!(initial.chat_sessions.is_empty());

            let host = pilo.host.clone();
            let ((), ()) = tokio::join!(stop_host(host.clone()), stop_host(host.clone()));
            assert!(matches!(Pilo::load_bootstrap(host).await, Err(error) if error == CLOSED));
        });
    }

    #[test]
    fn bootstrap_surfaces_database_errors() {
        let data = tempfile::tempdir().unwrap();
        let database = data.path().join("pilo.sqlite3");
        std::fs::create_dir(&database).unwrap();
        let pilo = Pilo::new(Some(data.path().to_str().unwrap().into())).unwrap();
        pilo.executor.block_on(async {
            let result = Pilo::load_bootstrap(pilo.host.clone()).await;
            assert!(
                matches!(result, Err(error) if error.contains("failed to open Pilo SQLite index"))
            );
            std::fs::remove_dir(database).unwrap();
            assert!(Pilo::load_bootstrap(pilo.host.clone()).await.is_ok());
            stop_host(pilo.host.clone()).await;
        });
    }

    #[test]
    fn runtime_operation_does_not_block_shutdown() {
        let data = tempfile::tempdir().unwrap();
        let pilo = Pilo::new(Some(data.path().to_str().unwrap().into())).unwrap();
        pilo.executor.block_on(async {
            let (admitted, ready) = tokio::sync::oneshot::channel();
            let (finish, pending) = tokio::sync::oneshot::channel();
            let operation = tokio::spawn(run_with_runtime(pilo.host.clone(), |_| async move {
                admitted.send(()).unwrap();
                pending.await.unwrap();
                Ok(())
            }));
            ready.await.unwrap();
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                stop_host(pilo.host.clone()),
            )
            .await
            .expect("shutdown waited for an admitted operation");
            assert_eq!(
                run_with_runtime(pilo.host.clone(), |_| async { Ok(()) }).await,
                Err(CLOSED.to_owned()),
            );
            finish.send(()).unwrap();
            operation.await.unwrap().unwrap();
        });
    }

    #[test]
    fn web_assets_only_serves_files_inside_its_root() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("webui");
        let external = data.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("index.html"), b"<p>Pilo</p>").unwrap();
        std::fs::write(&external, b"not an asset").unwrap();
        std::os::unix::fs::symlink(external, root.join("link")).unwrap();
        let assets = ShellWebAssets(root);
        let index = assets.get("index.html").unwrap();
        assert_eq!(index.mime_type, "text/html");
        assert_eq!(index.bytes, b"<p>Pilo</p>");
        for path in ["", "../outside", "/index.html", "missing", "link"] {
            assert!(assets.get(path).is_none(), "{path}");
        }
    }
}
