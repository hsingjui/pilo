use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

use nsh_core::{JsonValue, prelude::*};
use pilo_domain::{Connection, RemoteAccessAddress};
use pilo_runtime::{
    Runtime, TranscriptWindow,
    appearance::{theme_settings_get, theme_settings_set},
    cache_keep_alive::{cache_keep_alive_settings_list, cache_keep_alive_settings_set},
    connections::{
        connection_health_get, connection_models_get, connection_naming_model_list,
        connection_naming_model_set, connection_pi_probe, connection_settings_update,
        connection_shown_in_home_set, local_connection_get, local_connection_test,
        ssh::{
            SaveSshConnectionRequest, ssh_agent_identities_list, ssh_connection_list,
            ssh_connection_password_get, ssh_connection_remove, ssh_connection_save,
            ssh_connection_test, ssh_connection_test_draft,
        },
        wsl::{
            wsl_connection_list, wsl_connection_remove, wsl_connection_save, wsl_connection_test,
            wsl_list_distributions,
        },
    },
    events::{EventQueueLimits, EventStream},
    handle::{session_mark_read, session_read_states},
    host_paths::HostPaths,
    initialize_local_server_binary, initialize_server_resource_dir,
    next_prompt::{next_prompt_request, next_prompt_settings_get, next_prompt_settings_set},
    preferences::{preferences_get, preferences_patch},
    project_api::{
        connection_fs_read_dir, local_pick_project_directory, project_add,
        project_chat_file_remove, project_chat_file_upload, project_fs_read_image,
        project_fs_search, project_model_cache_list, project_model_cache_set,
        project_model_scope_get, project_model_scope_set, project_remove,
    },
    prompt_enhancement::{
        prompt_enhance, prompt_enhancement_settings_get, prompt_enhancement_settings_set,
    },
    remote::{
        remote_device_rename, remote_device_revoke, remote_host_state, remote_lan_addresses,
        remote_pairing_regenerate, remote_set_addresses, remote_set_enabled, remote_set_port,
        remote_set_public_base_url,
    },
    runtime_api::{
        chat_session_send_rpc, chat_session_start, chat_session_state, chat_session_stop,
    },
    session_api::{
        session_delete, session_history, session_history_image, session_reconcile, session_search,
        session_update_ui_state,
    },
    session_naming::session_generate_title,
    storage,
};
use tokio::{runtime::Runtime as Executor, sync::Mutex};

mod encode;
mod host;
mod objects;
mod shell;

use encode::{encode_event_batch, encode_list, history_fingerprint_args, load_projects};
use host::{CLOSED, Host, run_with_runtime, stop_host};
use objects::{
    Bootstrap, NativeDesktopSettings, NativeHistoryFingerprint, NativeHistoryOptions,
    NativePreferencesSnapshot, NativeSessionReadState, NativeStartChatInput,
};
use shell::{
    NshHostShell, ShellEvents, ShellWebAssets, data_identifier, default_data_dir, executor,
    log_directory, open_path, workspace,
};

const EVENT_QUEUE_LIMITS: EventQueueLimits = EventQueueLimits {
    max_events: 2048,
    max_bytes: 16 * 1024 * 1024,
};

/// A native host for the shared Pilo runtime.
#[class]
pub struct Pilo {
    host: Host,
    paths: HostPaths,
    executor: &'static Executor,
    event_stream: Arc<Mutex<EventStream>>,
}

impl Pilo {
    async fn load_bootstrap(host: Host) -> Result<Bootstrap, String> {
        let host = host.lock().await;
        let runtime = host.as_ref().ok_or(CLOSED)?.clone();
        let executor = tokio::runtime::Handle::current();
        let snapshot =
            tokio::task::spawn_blocking(move || executor.block_on(runtime.bootstrap_snapshot()))
                .await
                .map_err(|error| format!("failed to load bootstrap snapshot: {error}"))??;
        Ok(Bootstrap {
            event_sequence: snapshot.event_sequence,
            projects: encode_list(snapshot.projects)?,
            chat_sessions: encode_list(snapshot.chat_sessions)?,
            preferences: snapshot.preferences.into(),
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
    /// Opens Pilo on the existing Tauri data directory, or an explicit absolute directory.
    pub fn new(data_dir: Option<String>) -> Result<Self, String> {
        let data_dir = match data_dir {
            Some(path) => PathBuf::from(path),
            None => {
                let variable = if cfg!(windows) { "APPDATA" } else { "HOME" };
                let base = std::env::var_os(variable)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        format!("could not find the Pilo data directory: {variable} is unavailable")
                    })?;
                let development = cfg!(debug_assertions);
                if cfg!(windows) {
                    PathBuf::from(base).join(data_identifier(development))
                } else {
                    default_data_dir(Path::new(&base), development)
                }
            }
        };
        if !data_dir.is_absolute() {
            return Err("Pilo data directory must be an absolute path".into());
        }

        let resources = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|dir| dir.join("../Resources")))
            .ok_or("could not locate Pilo application resources")?;
        let paths = HostPaths::new(data_dir.clone(), resources.clone())?;
        let executor = executor()?;
        let (web_root, default_server) = if cfg!(debug_assertions) {
            let workspace = workspace()?;
            let server = workspace.join("target/debug/pilo-server");
            let target = format!("{}-apple-darwin", std::env::consts::ARCH);
            let target_server = workspace
                .join("target")
                .join(target)
                .join("debug/pilo-server");
            let server = if !server.is_file() && target_server.is_file() {
                target_server
            } else {
                server
            };
            (workspace.join("dist"), server)
        } else {
            (
                resources.join("webui"),
                resources.join("runtime/pilo-server-darwin-aarch64"),
            )
        };
        let server = std::env::var_os("PILO_SERVER_BINARY")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_server);
        initialize_server_resource_dir(resources);
        initialize_local_server_binary(server);
        let runtime = Runtime::new(paths.clone(), Arc::new(ShellEvents))
            .with_shell(Arc::new(NshHostShell {
                cache_dir: data_dir.join("cache"),
            }))?
            .with_web_assets(Arc::new(ShellWebAssets(web_root)))?;
        let event_stream = runtime.subscribe_events(EVENT_QUEUE_LIMITS);
        runtime.start_idle_reaper();
        let host = Arc::new(Mutex::new(None));
        // Finish restoring the saved listener before commands or shutdown can reach the Host.
        let mut startup = Arc::clone(&host)
            .try_lock_owned()
            .map_err(|error| format!("failed to initialize the Pilo host: {error}"))?;
        executor.spawn(async move {
            if let Err(error) = runtime.restore_remote().await {
                eprintln!("failed to restore Remote WebUI: {error}");
            }
            *startup = Some(runtime);
        });
        Ok(Self {
            host,
            paths,
            executor,
            event_stream: Arc::new(Mutex::new(event_stream)),
        })
    }

    /// Reads the saved project catalog, live chat snapshots and Host preferences.
    pub async fn bootstrap(this: Instance<Self>) -> Result<Bootstrap, String> {
        let task = this.with(|pilo| pilo.executor.spawn(Self::load_bootstrap(pilo.host.clone())));
        task.await
            .map_err(|error| format!("failed to bootstrap Pilo: {error}"))?
    }

    /// Waits for an ordered batch, an inclusive gap, or a closed event stream.
    pub async fn next_events(this: Instance<Self>, max: f64) -> Result<JsonValue, String> {
        let invalid = "event batch size must be a positive safe integer";
        if !(1.0..=9_007_199_254_740_991.0).contains(&max) || max.fract() != 0.0 {
            return Err(invalid.into());
        }
        let max = usize::try_from(max as u64).map_err(|_| invalid)?;
        let stream = this.with(|pilo| pilo.event_stream.clone());
        let batch = stream.lock().await.next_batch(max).await;
        encode_event_batch(batch)
    }

    /// Reads the saved project catalog without loading live chat snapshots.
    pub async fn list_projects(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime_blocking(this, load_projects).await
    }

    /// The connections a project can live on (local, WSL, SSH).
    pub async fn list_connections(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime_blocking(this, |runtime| {
            let mut connections = vec![local_connection_get(&runtime)?];
            connections.extend(
                wsl_connection_list(&runtime)?
                    .into_iter()
                    .map(|info| info.connection),
            );
            connections.extend(
                ssh_connection_list(&runtime)?
                    .into_iter()
                    .map(|info| info.connection),
            );
            encode_list(connections)
        })
        .await
    }

    /// The local connection row, created if the catalog does not have it yet.
    pub async fn get_local_connection(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, |runtime| {
            serde_json::to_value(local_connection_get(&runtime)?).map_err(|error| error.to_string())
        })
        .await
    }

    /// Renames a connection and sets its custom Pi executable path.
    pub async fn update_connection_settings(
        this: Instance<Self>,
        id: String,
        name: String,
        pi_executable: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let connection = connection_settings_update(&runtime, id, name, pi_executable)?;
            serde_json::to_value(connection).map_err(|error| error.to_string())
        })
        .await
    }

    /// Toggles whether a connection shows in the home environment list.
    pub async fn set_connection_shown_in_home(
        this: Instance<Self>,
        id: String,
        shown: bool,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let connection = connection_shown_in_home_set(&runtime, id, shown)?;
            serde_json::to_value(connection).map_err(|error| error.to_string())
        })
        .await
    }

    /// Pings the connection and probes its Pi executable for diagnostics.
    pub async fn get_connection_health(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let health = connection_health_get(&runtime, id).await?;
            serde_json::to_value(health).map_err(|error| error.to_string())
        })
        .await
    }

    /// Probes a Pi executable path on a connection without saving it.
    pub async fn probe_connection_pi(
        this: Instance<Self>,
        id: String,
        executable: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let info = connection_pi_probe(&runtime, id, executable).await?;
            serde_json::to_value(info).map_err(|error| error.to_string())
        })
        .await
    }

    /// Pings the local pilo-server connection.
    pub async fn test_local_connection(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let result = local_connection_test(&runtime).await?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        })
        .await
    }

    /// The SSH connections in the catalog, with project counts and secret flags.
    pub async fn list_ssh_connections(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime_blocking(this, |runtime| encode_list(ssh_connection_list(&runtime)?))
            .await
    }

    /// The SSH agent's public identities, for the connection editor.
    pub async fn list_ssh_agent_identities(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime(this, move |runtime| async move {
            encode_list(ssh_agent_identities_list(&runtime).await?)
        })
        .await
    }

    /// Saves an SSH connection draft; `password` replaces its stored secret.
    pub async fn save_ssh_connection(
        this: Instance<Self>,
        request: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let request: SaveSshConnectionRequest =
                serde_json::from_value(request).map_err(|error| error.to_string())?;
            let info = ssh_connection_save(&runtime, request).await?;
            serde_json::to_value(info).map_err(|error| error.to_string())
        })
        .await
    }

    /// The stored password of an SSH connection, or null when it has none.
    pub async fn get_ssh_connection_password(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            serde_json::to_value(ssh_connection_password_get(&runtime, id)?)
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Removes an SSH connection, stopping its projects first.
    pub async fn remove_ssh_connection(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            ssh_connection_remove(&runtime, id).await?;
            Ok(JsonValue::Null)
        })
        .await
    }

    /// Pings a saved SSH connection.
    pub async fn test_ssh_connection(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let result = ssh_connection_test(&runtime, id).await?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        })
        .await
    }

    /// Pings an SSH draft before it is saved.
    pub async fn test_ssh_connection_draft(
        this: Instance<Self>,
        connection: JsonValue,
        password: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let connection: Connection =
                serde_json::from_value(connection).map_err(|error| error.to_string())?;
            let result = ssh_connection_test_draft(&runtime, connection, password).await?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        })
        .await
    }

    /// The WSL distributions on the host; errors when WSL is unavailable.
    pub async fn list_wsl_distributions(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime(this, move |runtime| async move {
            encode_list(
                wsl_list_distributions(&runtime)
                    .await
                    .map_err(|error| error.to_string())?,
            )
        })
        .await
    }

    /// The WSL connections in the catalog, with project counts.
    pub async fn list_wsl_connections(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime_blocking(this, |runtime| encode_list(wsl_connection_list(&runtime)?))
            .await
    }

    /// Saves a WSL connection row.
    pub async fn save_wsl_connection(
        this: Instance<Self>,
        connection: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let connection: Connection =
                serde_json::from_value(connection).map_err(|error| error.to_string())?;
            let info = wsl_connection_save(&runtime, connection)?;
            serde_json::to_value(info).map_err(|error| error.to_string())
        })
        .await
    }

    /// Removes a WSL connection, stopping its projects first.
    pub async fn remove_wsl_connection(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            wsl_connection_remove(&runtime, id).await?;
            Ok(JsonValue::Null)
        })
        .await
    }

    /// Pings a WSL distribution before or after saving it as a connection.
    pub async fn test_wsl_connection(
        this: Instance<Self>,
        distro: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let result = wsl_connection_test(&runtime, distro).await?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        })
        .await
    }

    /// Adds a project directory on a connection to the catalog.
    pub async fn add_project(
        this: Instance<Self>,
        connection_id: String,
        path: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let project = project_add(&runtime, connection_id, path).await?;
            serde_json::to_value(project).map_err(|error| error.to_string())
        })
        .await
    }

    /// Reads a directory on a non-local connection for the remote browser.
    pub async fn read_connection_dir(
        this: Instance<Self>,
        connection_id: String,
        path: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime(this, move |runtime| async move {
            encode_list(connection_fs_read_dir(&runtime, connection_id, path).await?)
        })
        .await
    }

    /// The host's native folder picker; `null` when dismissed.
    pub async fn pick_local_project_directory(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, |runtime| {
            serde_json::to_value(local_pick_project_directory(&runtime)?)
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Removes the project from the catalog, stopping its chats first.
    pub async fn remove_project(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime(this, move |runtime| async move {
            encode_list(project_remove(&runtime, project_id).await?)
        })
        .await
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

    /// Reads Pi's current user-level model catalog for the connection.
    pub async fn load_connection_models(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime(this, move |runtime| async move {
            connection_models_get(&runtime, connection_id).await
        })
        .await
    }

    /// Reads a cached project catalog without launching Pi.
    pub async fn load_models(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let snapshot = project_model_cache_list(runtime)?
                .into_iter()
                .find(|snapshot| snapshot.project_id == project_id);
            serde_json::to_value(snapshot).map_err(|error| error.to_string())
        })
        .await
    }

    /// Reads the Host's saved model scope for a project.
    pub async fn load_model_scope(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let scope = project_model_scope_get(runtime, project_id)?;
            serde_json::to_value(scope).map_err(|error| error.to_string())
        })
        .await
    }

    /// Persists a refreshed project model catalog snapshot.
    pub async fn save_models(
        this: Instance<Self>,
        snapshot: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let cache: pilo_domain::ProjectModelCache =
                serde_json::from_value(snapshot).map_err(|error| error.to_string())?;
            let cache = project_model_cache_set(
                runtime,
                cache.project_id,
                cache.models,
                cache.commands,
                cache.default_model,
                cache.default_thinking_level,
                cache.refreshed_at_ms,
            )?;
            serde_json::to_value(cache).map_err(|error| error.to_string())
        })
        .await
    }

    /// Lists each connection's saved session-naming model.
    pub async fn load_naming_models(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let models = connection_naming_model_list(runtime)?;
            serde_json::to_value(models).map_err(|error| error.to_string())
        })
        .await
    }

    /// Sets or clears a connection's session-naming model.
    pub async fn save_naming_model(
        this: Instance<Self>,
        connection_id: String,
        provider: Option<String>,
        model_id: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let model = connection_naming_model_set(runtime, connection_id, provider, model_id)?;
            serde_json::to_value(model).map_err(|error| error.to_string())
        })
        .await
    }

    /// Replaces a project's saved model scope or restores Pi inheritance.
    pub async fn save_model_scope(
        this: Instance<Self>,
        project_id: String,
        models: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let models = serde_json::from_value(models).map_err(|error| error.to_string())?;
            let scope = project_model_scope_set(runtime, project_id, models)?;
            serde_json::to_value(scope).map_err(|error| error.to_string())
        })
        .await
    }

    /// Lists the saved cache keep-alive policies for a connection.
    pub async fn load_cache_keep_alive_settings(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            encode_list(cache_keep_alive_settings_list(runtime, connection_id)?)
        })
        .await
    }

    /// Saves a model's cache keep-alive policy for a connection.
    pub async fn save_cache_keep_alive_settings(
        this: Instance<Self>,
        settings: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let settings = serde_json::from_value(settings).map_err(|error| error.to_string())?;
            let settings = cache_keep_alive_settings_set(&runtime, settings).await?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
        })
        .await
    }

    /// Reads the connection's saved next-prompt settings.
    pub async fn load_next_prompt_settings(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let settings = next_prompt_settings_get(runtime, connection_id)?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
        })
        .await
    }

    /// Saves next-prompt settings for a connection.
    pub async fn save_next_prompt_settings(
        this: Instance<Self>,
        connection_id: String,
        enabled: bool,
        model: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let model = serde_json::from_value(model).map_err(|error| error.to_string())?;
            let settings = next_prompt_settings_set(runtime, connection_id, enabled, model)?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
        })
        .await
    }

    /// Requests or cancels next-prompt assistance in an existing chat.
    pub async fn request_next_prompt(
        this: Instance<Self>,
        request: JsonValue,
    ) -> Result<(), String> {
        Self::with_runtime(this, move |runtime| async move {
            let request = serde_json::from_value(request).map_err(|error| error.to_string())?;
            next_prompt_request(&runtime, request).await
        })
        .await
    }

    /// Reads the connection's saved prompt enhancement settings.
    pub async fn load_prompt_enhancement_settings(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let settings = prompt_enhancement_settings_get(runtime, connection_id)?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
        })
        .await
    }

    /// Saves prompt enhancement settings for a connection.
    pub async fn save_prompt_enhancement_settings(
        this: Instance<Self>,
        connection_id: String,
        enabled: bool,
        model: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let model = serde_json::from_value(model).map_err(|error| error.to_string())?;
            let settings = prompt_enhancement_settings_set(runtime, connection_id, enabled, model)?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
        })
        .await
    }

    /// Rewrites a draft using the connection's prompt enhancement settings.
    pub async fn enhance_prompt(
        this: Instance<Self>,
        project_id: String,
        draft: String,
        model: JsonValue,
    ) -> Result<String, String> {
        Self::with_runtime(this, move |runtime| async move {
            let model = serde_json::from_value(model).map_err(|error| error.to_string())?;
            prompt_enhance(&runtime, project_id, draft, model).await
        })
        .await
    }

    /// Searches saved session messages for a project.
    pub async fn search_sessions(
        this: Instance<Self>,
        project_id: String,
        query: String,
        limit: Option<f64>,
    ) -> Result<Vec<JsonValue>, String> {
        Self::with_runtime(this, move |runtime| async move {
            let limit = limit
                .map(|limit| {
                    let invalid = "session search limit must be a non-negative safe integer";
                    if !(0.0..=9_007_199_254_740_991.0).contains(&limit) || limit.fract() != 0.0 {
                        return Err(invalid.to_owned());
                    }
                    usize::try_from(limit as u64).map_err(|_| invalid.to_owned())
                })
                .transpose()?;
            encode_list(session_search(&runtime, project_id, query, limit).await?)
        })
        .await
    }

    /// Stores a composer attachment inside the project and returns its path.
    pub async fn upload_chat_file(
        this: Instance<Self>,
        project_id: String,
        name: String,
        data: Vec<u8>,
    ) -> Result<String, String> {
        Self::with_runtime(this, move |runtime| async move {
            project_chat_file_upload(&runtime, project_id, name, data).await
        })
        .await
    }

    /// Removes a stored composer attachment.
    pub async fn remove_chat_file(
        this: Instance<Self>,
        project_id: String,
        path: String,
    ) -> Result<(), String> {
        Self::with_runtime(this, move |runtime| async move {
            project_chat_file_remove(&runtime, project_id, path).await
        })
        .await
    }

    /// Searches project file paths for composer `@` mentions.
    pub async fn search_project_files(
        this: Instance<Self>,
        project_id: String,
        query: String,
    ) -> Result<Vec<String>, String> {
        Self::with_runtime(this, move |runtime| async move {
            project_fs_search(&runtime, project_id, query).await
        })
        .await
    }

    /// Generates a title with the connection's naming model, if configured.
    pub async fn generate_session_title(
        this: Instance<Self>,
        project_id: String,
        message: String,
    ) -> Result<Option<String>, String> {
        Self::with_runtime(this, move |runtime| async move {
            session_generate_title(&runtime, project_id, message).await
        })
        .await
    }

    /// Deletes an indexed session and returns the removal method.
    pub async fn delete_session(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            serde_json::to_value(session_delete(&runtime, project_id, session_path).await?)
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Updates an indexed session's pin state or title override.
    pub async fn update_session_ui_state(
        this: Instance<Self>,
        session_path: String,
        update: JsonValue,
        project_id: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let update = serde_json::from_value(update).map_err(|error| error.to_string())?;
            let entry = session_update_ui_state(runtime, session_path, update, project_id)?;
            serde_json::to_value(entry).map_err(|error| error.to_string())
        })
        .await
    }

    /// Reads a window of settled session history without starting Pi.
    pub async fn load_history(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
        options: Option<NativeHistoryOptions>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let options = options.unwrap_or_default();
            let checked_integer = |value: f64| {
                if !(0.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
                    return Err(
                        "history window offsets and limits must be non-negative safe integers"
                            .to_owned(),
                    );
                }
                Ok(value as usize)
            };
            let start = options.start_message.map(checked_integer).transpose()?;
            let limit = checked_integer(options.message_limit.unwrap_or(256.0))?;
            let (file_size, file_mtime_ns) = history_fingerprint_args(options.fingerprint)?;
            let history = session_history(
                &runtime,
                project_id,
                session_path,
                file_size,
                file_mtime_ns,
                start,
                Some(limit),
                Some(options.include_message_index.unwrap_or(true)),
            )
            .await?;
            serde_json::from_slice(&history).map_err(|error| error.to_string())
        })
        .await
    }

    /// Reads one image attachment from a Pi session's JSONL.
    pub async fn read_history_image(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
        image_id: String,
        fingerprint: Option<NativeHistoryFingerprint>,
    ) -> Result<Vec<u8>, String> {
        Self::with_runtime(this, move |runtime| async move {
            let (file_size, file_mtime_ns) = history_fingerprint_args(fingerprint)?;
            session_history_image(
                &runtime,
                project_id,
                session_path,
                image_id,
                file_size,
                file_mtime_ns,
            )
            .await
        })
        .await
    }

    /// Reads a supported image from a project-relative path.
    pub async fn read_project_image(
        this: Instance<Self>,
        project_id: String,
        path: String,
    ) -> Result<Vec<u8>, String> {
        Self::with_runtime(this, move |runtime| async move {
            project_fs_read_image(&runtime, project_id, path).await
        })
        .await
    }

    /// Starts or resumes a Pi chat and returns its ready process snapshot.
    pub async fn start_chat(
        this: Instance<Self>,
        input: NativeStartChatInput,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let builtin_extensions = input
                .builtin_extensions
                .map(|extensions| {
                    let extensions = extensions
                        .into_iter()
                        .map(|extension| serde_json::json!({ "id": extension.id }))
                        .collect();
                    serde_json::from_value(JsonValue::Array(extensions))
                        .map_err(|error| error.to_string())
                })
                .transpose()?;
            let snapshot = chat_session_start(
                &runtime,
                input.project_id,
                input.session_key,
                input.session_path,
                input.no_session.unwrap_or(false),
                None,
                builtin_extensions,
            )
            .await?;
            serde_json::to_value(snapshot).map_err(|error| error.to_string())
        })
        .await
    }

    /// Returns the Remote Host's live state (enabled, addresses, pairing, devices).
    pub async fn remote_host_state(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime(this, |runtime| async move {
            let state = remote_host_state(&runtime).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Lists the machine's LAN IPs for the Remote Host address picker.
    pub async fn remote_lan_addresses(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime(this, |runtime| async move {
            let addresses = remote_lan_addresses(&runtime).await?;
            serde_json::to_value(addresses).map_err(|error| error.to_string())
        })
        .await
    }

    /// Enables or disables the Remote Host.
    pub async fn remote_set_enabled(
        this: Instance<Self>,
        enabled: bool,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let state = remote_set_enabled(&runtime, enabled).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Sets the Remote Host's listen port.
    pub async fn remote_set_port(this: Instance<Self>, port: f64) -> Result<JsonValue, String> {
        if !port.is_finite() || port.fract() != 0.0 || !(0.0..=65535.0).contains(&port) {
            return Err(format!("invalid port: {port}"));
        }
        Self::with_runtime(this, move |runtime| async move {
            let state = remote_set_port(&runtime, port as u16).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Sets the Remote Host's public base URL.
    pub async fn remote_set_public_base_url(
        this: Instance<Self>,
        public_base_url: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let state = remote_set_public_base_url(&runtime, public_base_url).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Replaces the Remote Host's access addresses and entry selection.
    pub async fn remote_set_addresses(
        this: Instance<Self>,
        addresses: JsonValue,
        entry_address_id: String,
    ) -> Result<JsonValue, String> {
        let addresses: Vec<RemoteAccessAddress> =
            serde_json::from_value(addresses).map_err(|error| error.to_string())?;
        Self::with_runtime(this, move |runtime| async move {
            let state = remote_set_addresses(&runtime, addresses, entry_address_id).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Regenerates the Remote Host's pairing link.
    pub async fn remote_pairing_regenerate(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime(this, |runtime| async move {
            let state = remote_pairing_regenerate(&runtime).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Revokes a paired Remote device.
    pub async fn remote_device_revoke(
        this: Instance<Self>,
        device_id: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let state = remote_device_revoke(&runtime, device_id).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Renames a paired Remote device.
    pub async fn remote_device_rename(
        this: Instance<Self>,
        device_id: String,
        name: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let state = remote_device_rename(&runtime, device_id, name).await?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        })
        .await
    }

    /// Opens the app's log directory in the file manager.
    pub async fn open_log_directory(this: Instance<Self>) -> Result<(), String> {
        let _ = this;
        let directory = log_directory(cfg!(debug_assertions))?;
        open_path(&directory)
    }

    /// Stops a Pi chat; stopping an absent session succeeds.
    pub async fn stop_chat(
        this: Instance<Self>,
        session_key: String,
        reason: Option<String>,
    ) -> Result<(), String> {
        Self::with_runtime(this, move |runtime| async move {
            chat_session_stop(&runtime, session_key, reason).await
        })
        .await
    }

    /// Returns a live chat state, or null when none is available for the key.
    pub async fn chat_state(
        this: Instance<Self>,
        session_key: String,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            serde_json::to_value(chat_session_state(&runtime, session_key).await?)
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Captures persisted history and the live transcript at an ordered event cut.
    pub async fn chat_transcript_snapshot(
        this: Instance<Self>,
        session_key: String,
        window: Option<JsonValue>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            let window: TranscriptWindow = window
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| error.to_string())?
                .unwrap_or_default();
            let snapshot = runtime
                .chat_transcript_snapshot(&session_key, window)
                .await?;
            serde_json::to_value(snapshot).map_err(|error| error.to_string())
        })
        .await
    }

    /// Sends a Pi RPC command; responses arrive independently on the event stream.
    pub async fn send_chat_command(
        this: Instance<Self>,
        session_key: String,
        command: JsonValue,
    ) -> Result<(), String> {
        Self::with_runtime(this, move |runtime| async move {
            chat_session_send_rpc(&runtime, session_key, command).await
        })
        .await
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

    /// Reads the saved global show shortcut and main-window close behavior.
    pub async fn load_desktop_settings(
        this: Instance<Self>,
    ) -> Result<NativeDesktopSettings, String> {
        let paths = this.with(|pilo| pilo.paths.clone());
        Self::with_runtime_blocking(this, move |_| {
            let db = storage::open(&paths)?;
            Ok(NativeDesktopSettings {
                show_shortcut: storage::get_show_shortcut(&db)?,
                exit_on_close: storage::get_exit_on_close(&db)?,
            })
        })
        .await
    }

    /// Saves whether closing the main window quits Pilo instead of hiding it.
    pub async fn save_exit_on_close(this: Instance<Self>, enabled: bool) -> Result<(), String> {
        let paths = this.with(|pilo| pilo.paths.clone());
        Self::with_runtime_blocking(this, move |_| {
            storage::set_exit_on_close(&storage::open(&paths)?, enabled)
        })
        .await
    }

    /// Saves only after the shell has registered the key with the OS.
    pub async fn save_show_shortcut(this: Instance<Self>, shortcut: String) -> Result<(), String> {
        let paths = this.with(|pilo| pilo.paths.clone());
        Self::with_runtime_blocking(this, move |_| {
            storage::save_registered_show_shortcut(&paths, &shortcut)
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
        initial: Option<bool>,
    ) -> Result<NativePreferencesSnapshot, String> {
        Self::with_runtime_blocking(this, move |runtime| {
            let JsonValue::Object(patch) = patch else {
                return Err("Pilo preference patch must be an object".into());
            };
            preferences_patch(runtime, patch, initial).map(Into::into)
        })
        .await
    }

    /// Reads the complete Host appearance settings, including tokens and conversion reports.
    pub async fn load_theme_settings(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime(this, |runtime| async move {
            let settings = theme_settings_get(&runtime, None).await?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
        })
        .await
    }

    /// Applies a Host appearance update and returns the complete settings.
    pub async fn save_theme_settings(
        this: Instance<Self>,
        update: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            if !update.is_object() {
                return Err("Pilo theme settings update must be an object".into());
            }
            let update = serde_json::from_value(update).map_err(|error| error.to_string())?;
            let settings = theme_settings_set(&runtime, update).await?;
            serde_json::to_value(settings).map_err(|error| error.to_string())
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
mod tests;
