use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

use nsh_core::{
    JsonValue, element,
    file_dialog::{OpenDialog, SaveDialog},
    prelude::*,
};
use pilo_runtime::{
    Runtime, TERMINAL_QUEUE_MAX_BYTES, TerminalEventStream,
    appearance::system_font_families,
    events::{EventQueueLimits, EventStream},
    host_api::{self, BinaryOutput, Principal},
    host_paths::HostPaths,
    initialize_local_server_binary, initialize_server_resource_dir, project_api,
    project_opener::ProjectApp,
    storage,
};
use serde::de::DeserializeOwned;
use serde_json::json;
use tokio::{runtime::Runtime as Executor, sync::Mutex};

mod encode;
mod host;
mod objects;
mod shell;

use encode::{
    encode_event_batch, encode_terminal_events, history_fingerprint_args, positive_count,
    terminal_size,
};
#[cfg(test)]
use host::CLOSED;
use host::{Host, call_local, decode_host_response, run_with_runtime, stop_host};
use objects::{
    Bootstrap, NativeDesktopSettings, NativeHistoryFingerprint, NativeHistoryOptions,
    NativePreferencesSnapshot, NativeSessionReadState, NativeStartChatInput,
};
use shell::{
    NshHostShell, ShellWebAssets, data_identifier, default_data_dir, executor, init_file_logger,
    read_local_file, resolve_log_directory, sanitize_save_file_name, server_resource_name,
    workspace,
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
    terminal_events: Arc<TerminalEventStream>,
}

impl Pilo {
    async fn load_bootstrap(host: Host) -> Result<Bootstrap, String> {
        run_with_runtime(host, |runtime| async move {
            call_local(&runtime, "host.bootstrap", json!({})).await
        })
        .await
    }

    async fn host_call<T: DeserializeOwned + Send + 'static>(
        this: Instance<Self>,
        method: &'static str,
        params: JsonValue,
    ) -> Result<T, String> {
        Self::with_runtime(this, move |runtime| async move {
            call_local(&runtime, method, params).await
        })
        .await
    }

    async fn host_download(
        this: Instance<Self>,
        method: &'static str,
        params: JsonValue,
    ) -> Result<Vec<u8>, String> {
        Self::with_runtime(this, move |runtime| async move {
            match host_api::call_binary(&runtime, &Principal::Local, method, params, None)
                .await
                .map_err(|err| err.message)?
            {
                BinaryOutput::Bytes(bytes) => Ok(bytes),
                BinaryOutput::Json(_) => Err("expected a Host API binary result".into()),
            }
        })
        .await
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
    /// Opens Pilo on the existing app data directory, or an explicit absolute directory.
    pub fn new(data_dir: Option<String>, log_file: Option<String>) -> Result<Self, String> {
        let default_launch = data_dir.is_none();
        let data_dir = match data_dir {
            Some(path) => PathBuf::from(path),
            None if cfg!(target_os = "linux") => {
                let base = std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .or_else(|| std::env::home_dir().map(|home| home.join(".local/share")))
                    .ok_or("could not find the Pilo data directory on Linux")?;
                base.join(data_identifier(cfg!(debug_assertions)))
            }
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
        if default_launch
            && let Ok(log_dir) = resolve_log_directory(log_file.as_deref(), cfg!(debug_assertions))
        {
            init_file_logger(log_dir);
        }

        let resources = std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.parent().map(|dir| {
                    if cfg!(target_os = "macos") {
                        dir.join("../Resources")
                    } else {
                        dir.to_path_buf()
                    }
                })
            })
            .ok_or("could not locate Pilo application resources")?;
        let paths = HostPaths::new(data_dir.clone(), resources.clone())?;
        let executor = executor()?;
        let (web_root, default_server) = if cfg!(debug_assertions) {
            let workspace = workspace()?;
            let server = workspace
                .join("target/debug/pilo-server")
                .with_extension(std::env::consts::EXE_EXTENSION);
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
                resources.join("runtime").join(server_resource_name()),
            )
        };
        let server = std::env::var_os("PILO_SERVER_BINARY")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_server);
        initialize_server_resource_dir(resources);
        initialize_local_server_binary(server);
        let runtime = Runtime::new(paths.clone())
            .with_shell(Arc::new(NshHostShell {
                cache_dir: data_dir.join("cache"),
                paths: paths.clone(),
            }))?
            .with_web_assets(Arc::new(ShellWebAssets::new(web_root)))?;
        let event_stream = runtime.subscribe_events(EVENT_QUEUE_LIMITS);
        let terminal_events = Arc::new(runtime.subscribe_terminal_events(TERMINAL_QUEUE_MAX_BYTES));
        runtime.start_idle_reaper();
        // Covers unavailable watchers and external Pi exits without a file write.
        runtime.start_external_activity_poll();
        let host = Arc::new(Mutex::new(Some(runtime.clone())));
        // Restore the saved Remote WebUI listener in the background without blocking startup IPC.
        executor.spawn(async move {
            if let Err(error) = runtime.restore_remote().await {
                eprintln!("failed to restore Remote WebUI: {error}");
            }
        });
        Ok(Self {
            host,
            paths,
            executor,
            event_stream: Arc::new(Mutex::new(event_stream)),
            terminal_events,
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
        let max = positive_count(max, "event batch size")?;
        let task = this.with(|pilo| {
            let stream = pilo.event_stream.clone();
            pilo.executor.spawn(async move {
                let batch = stream.lock().await.next_batch(max).await;
                encode_event_batch(batch)
            })
        });
        task.await
            .map_err(|error| format!("Pilo event stream task failed: {error}"))?
    }

    /// Reads the saved project catalog without loading live chat snapshots.
    pub async fn list_projects(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "project.list", json!({})).await
    }

    /// The connections a project can live on (local, WSL, SSH).
    pub async fn list_connections(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.list", json!({})).await
    }

    /// The local connection row, created if the catalog does not have it yet.
    pub async fn get_local_connection(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.local.get", json!({})).await
    }

    /// Renames a connection and sets its custom Pi executable path.
    pub async fn update_connection_settings(
        this: Instance<Self>,
        id: String,
        name: String,
        pi_executable: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "connection.settings.update",
            json!({"id": id, "name": name, "piExecutable": pi_executable}),
        )
        .await
    }

    /// Toggles whether a connection shows in the home environment list.
    pub async fn set_connection_shown_in_home(
        this: Instance<Self>,
        id: String,
        shown: bool,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "connection.shownInHome.set",
            json!({"id": id, "shown": shown}),
        )
        .await
    }

    /// Pings the connection and probes its Pi executable for diagnostics.
    pub async fn get_connection_health(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.health", json!({"id": id})).await
    }

    /// Probes a Pi executable path on a connection without saving it.
    pub async fn probe_connection_pi(
        this: Instance<Self>,
        id: String,
        executable: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "connection.pi.probe",
            json!({"id": id, "executable": executable}),
        )
        .await
    }

    /// Pings the local pilo-server connection.
    pub async fn test_local_connection(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.local.test", json!({})).await
    }

    /// The SSH connections in the catalog, with project counts and secret flags.
    pub async fn list_ssh_connections(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.ssh.list", json!({})).await
    }

    /// The SSH agent's public identities, for the connection editor.
    pub async fn list_ssh_agent_identities(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.ssh.agentIdentities", json!({})).await
    }

    /// Host aliases parsed from `~/.ssh/config` (and its `Include` files).
    pub async fn list_ssh_config_hosts(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.ssh.configHosts", json!({})).await
    }

    /// Private key files discovered under `~/.ssh/`.
    pub async fn list_ssh_local_keys(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.ssh.localKeys", json!({})).await
    }

    /// Saves an SSH connection draft; `password` replaces its stored secret.
    pub async fn save_ssh_connection(
        this: Instance<Self>,
        request: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.ssh.save", json!({"request": request})).await
    }

    /// The stored password of an SSH connection, or null when it has none.
    pub async fn get_ssh_connection_password(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.ssh.password", json!({"id": id})).await
    }

    /// Removes an SSH connection, stopping its projects first.
    pub async fn remove_ssh_connection(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.ssh.remove", json!({"id": id})).await
    }

    /// Pings a saved SSH connection.
    pub async fn test_ssh_connection(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.ssh.test", json!({"id": id})).await
    }

    /// Pings an SSH draft before it is saved.
    pub async fn test_ssh_connection_draft(
        this: Instance<Self>,
        connection: JsonValue,
        password: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "connection.ssh.testDraft",
            json!({"connection": connection, "password": password}),
        )
        .await
    }

    /// The WSL distributions on the host; errors when WSL is unavailable.
    pub async fn list_wsl_distributions(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.wsl.distributions", json!({})).await
    }

    /// The WSL connections in the catalog, with project counts.
    pub async fn list_wsl_connections(this: Instance<Self>) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "connection.wsl.list", json!({})).await
    }

    /// Saves a WSL connection row.
    pub async fn save_wsl_connection(
        this: Instance<Self>,
        connection: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "connection.wsl.save",
            json!({"connection": connection}),
        )
        .await
    }

    /// Removes a WSL connection, stopping its projects first.
    pub async fn remove_wsl_connection(
        this: Instance<Self>,
        id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.wsl.remove", json!({"id": id})).await
    }

    /// Pings a WSL distribution before or after saving it as a connection.
    pub async fn test_wsl_connection(
        this: Instance<Self>,
        distro: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.wsl.test", json!({"distro": distro})).await
    }

    /// Adds a project directory on a connection to the catalog.
    pub async fn add_project(
        this: Instance<Self>,
        connection_id: String,
        path: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "project.add",
            json!({"connectionId": connection_id, "path": path}),
        )
        .await
    }

    /// Reads a directory on a non-local connection for the remote browser.
    pub async fn read_connection_dir(
        this: Instance<Self>,
        connection_id: String,
        path: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::host_call(
            this,
            "connection.readDir",
            json!({"connectionId": connection_id, "path": path}),
        )
        .await
    }

    /// The host's native folder picker; `null` when dismissed.
    pub async fn pick_local_project_directory(
        this: Instance<Self>,
    ) -> Result<Option<String>, String> {
        let _ = this;
        let folders = element::pick_paths(OpenDialog::folders()).await?;
        Ok(folders
            .and_then(|folders| folders.into_iter().next())
            .map(|folder| folder.to_string_lossy().into_owned()))
    }

    /// Removes the project from the catalog, stopping its chats first.
    pub async fn remove_project(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::host_call(this, "project.remove", json!({"projectId": project_id})).await
    }

    /// Reconciles the session index, or reads it without a scan when `cached` is true.
    /// With `unwatched_only`, scans only when no live session watcher covers the project.
    pub async fn list_sessions(
        this: Instance<Self>,
        project_id: String,
        cached: Option<bool>,
        unwatched_only: Option<bool>,
    ) -> Result<Vec<JsonValue>, String> {
        Self::host_call(
            this,
            "session.list",
            json!({"projectId": project_id, "cached": cached, "unwatchedOnly": unwatched_only}),
        )
        .await
    }

    /// Reads Pi's current user-level model catalog for the connection.
    pub async fn load_connection_models(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::host_call(
            this,
            "connection.models",
            json!({"connectionId": connection_id}),
        )
        .await
    }

    /// Reads a cached project catalog without launching Pi.
    pub async fn load_models(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "models.get", json!({"projectId": project_id})).await
    }

    /// Reads the Host's saved model scope for a project.
    pub async fn load_model_scope(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "models.scope.get", json!({"projectId": project_id})).await
    }

    /// Persists a refreshed project model catalog snapshot.
    pub async fn save_models(
        this: Instance<Self>,
        snapshot: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "models.set", json!({"cache": snapshot})).await
    }

    /// Lists each connection's saved session-naming model.
    pub async fn load_naming_models(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "connection.namingModels.list", json!({})).await
    }

    /// Sets or clears a connection's session-naming model.
    pub async fn save_naming_model(
        this: Instance<Self>,
        connection_id: String,
        provider: Option<String>,
        model_id: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "connection.namingModels.set",
            json!({"connectionId": connection_id, "provider": provider, "modelId": model_id}),
        )
        .await
    }

    /// Replaces a project's saved model scope or restores Pi inheritance.
    pub async fn save_model_scope(
        this: Instance<Self>,
        project_id: String,
        models: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "models.scope.set",
            json!({"projectId": project_id, "models": models}),
        )
        .await
    }

    /// Lists the saved cache keep-alive policies for a connection.
    pub async fn load_cache_keep_alive_settings(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::host_call(
            this,
            "cacheKeepAlive.settings.list",
            json!({"connectionId": connection_id}),
        )
        .await
    }

    /// Saves a model's cache keep-alive policy for a connection.
    pub async fn save_cache_keep_alive_settings(
        this: Instance<Self>,
        settings: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "cacheKeepAlive.settings.set",
            json!({"settings": settings}),
        )
        .await
    }

    /// Pauses active prompt-cache keep-alive for one session without changing saved settings.
    pub async fn pause_cache_keep_alive(
        this: Instance<Self>,
        session_key: String,
    ) -> Result<(), String> {
        Self::host_call(
            this,
            "cacheKeepAlive.pause",
            json!({"sessionKey": session_key}),
        )
        .await
    }

    /// Reads the connection's saved next-prompt settings.
    pub async fn load_next_prompt_settings(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "nextPrompt.settings.get",
            json!({"connectionId": connection_id}),
        )
        .await
    }

    /// Saves next-prompt settings for a connection.
    pub async fn save_next_prompt_settings(
        this: Instance<Self>,
        connection_id: String,
        enabled: bool,
        model: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "nextPrompt.settings.set",
            json!({"connectionId": connection_id, "enabled": enabled, "model": model}),
        )
        .await
    }

    /// Requests or cancels next-prompt assistance in an existing chat.
    pub async fn request_next_prompt(
        this: Instance<Self>,
        request: JsonValue,
    ) -> Result<(), String> {
        Self::host_call(this, "nextPrompt.request", json!({"request": request})).await
    }

    /// Reads the connection's saved prompt enhancement settings.
    pub async fn load_prompt_enhancement_settings(
        this: Instance<Self>,
        connection_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "promptEnhancement.settings.get",
            json!({"connectionId": connection_id}),
        )
        .await
    }

    /// Saves prompt enhancement settings for a connection.
    pub async fn save_prompt_enhancement_settings(
        this: Instance<Self>,
        connection_id: String,
        enabled: bool,
        model: JsonValue,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "promptEnhancement.settings.set",
            json!({"connectionId": connection_id, "enabled": enabled, "model": model}),
        )
        .await
    }

    /// Rewrites a draft using the connection's prompt enhancement settings.
    pub async fn enhance_prompt(
        this: Instance<Self>,
        project_id: String,
        draft: String,
        model: JsonValue,
    ) -> Result<String, String> {
        Self::host_call(
            this,
            "promptEnhancement.enhance",
            json!({"projectId": project_id, "draft": draft, "model": model}),
        )
        .await
    }

    /// Searches saved session messages for a project.
    pub async fn search_sessions(
        this: Instance<Self>,
        project_id: String,
        query: String,
        limit: Option<f64>,
    ) -> Result<Vec<JsonValue>, String> {
        let limit = limit
            .map(|limit| {
                let invalid = "session search limit must be a non-negative safe integer";
                if !(0.0..=9_007_199_254_740_991.0).contains(&limit) || limit.fract() != 0.0 {
                    return Err(invalid.to_owned());
                }
                usize::try_from(limit as u64).map_err(|_| invalid.to_owned())
            })
            .transpose()?;
        Self::host_call(
            this,
            "session.search",
            json!({
                "projectId": project_id, "query": query, "limit": limit,
            }),
        )
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
            let result = host_api::call_binary(
                &runtime,
                &Principal::Local,
                "chat.files.upload",
                json!({"projectId": project_id, "name": name}),
                Some(&data),
            )
            .await
            .map_err(|err| err.message)?;
            match result {
                BinaryOutput::Json(value) => decode_host_response(value),
                BinaryOutput::Bytes(_) => Err("expected a Host API JSON upload result".into()),
            }
        })
        .await
    }

    /// Removes a stored composer attachment.
    pub async fn remove_chat_file(
        this: Instance<Self>,
        project_id: String,
        path: String,
    ) -> Result<(), String> {
        Self::host_call(
            this,
            "chat.files.remove",
            json!({"projectId": project_id, "path": path}),
        )
        .await
    }

    /// Searches project file paths for composer `@` mentions.
    pub async fn search_project_files(
        this: Instance<Self>,
        project_id: String,
        query: String,
    ) -> Result<Vec<String>, String> {
        Self::host_call(
            this,
            "files.search",
            json!({"projectId": project_id, "query": query}),
        )
        .await
    }

    /// Generates a title with the connection's naming model, if configured.
    pub async fn generate_session_title(
        this: Instance<Self>,
        project_id: String,
        message: String,
    ) -> Result<Option<String>, String> {
        Self::host_call(
            this,
            "session.title",
            json!({"projectId": project_id, "message": message}),
        )
        .await
    }

    /// Reads which of the project's sessions an external Pi runs a turn in.
    pub async fn external_session_activity(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<Vec<JsonValue>, String> {
        Self::host_call(
            this,
            "session.externalActivity",
            json!({"projectId": project_id}),
        )
        .await
    }

    /// Deletes an indexed session and returns the removal method.
    pub async fn delete_session(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "session.delete",
            json!({"projectId": project_id, "sessionPath": session_path}),
        )
        .await
    }

    /// Updates an indexed session's pin, title, or archive state.
    pub async fn update_session_ui_state(
        this: Instance<Self>,
        session_path: String,
        update: JsonValue,
        project_id: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "session.uiState.set",
            json!({"projectId": project_id, "sessionPath": session_path, "update": update}),
        )
        .await
    }

    /// Reads a window of settled session history without starting Pi.
    pub async fn load_history(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
        options: Option<NativeHistoryOptions>,
    ) -> Result<JsonValue, String> {
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
        let limit = options.message_limit.map(checked_integer).transpose()?;
        let (file_size, file_mtime_ns) = history_fingerprint_args(options.fingerprint)?;
        Self::host_call(
            this,
            "session.history",
            json!({
                "projectId": project_id, "sessionPath": session_path, "startMessage": start,
                "messageLimit": limit, "includeMessageIndex": options.include_message_index,
                "expectedFileSize": file_size, "expectedFileMtimeNs": file_mtime_ns,
            }),
        )
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
        let (file_size, file_mtime_ns) = history_fingerprint_args(fingerprint)?;
        Self::host_download(
            this,
            "session.historyImage",
            json!({
                "projectId": project_id, "sessionPath": session_path, "imageId": image_id,
                "expectedFileSize": file_size, "expectedFileMtimeNs": file_mtime_ns,
            }),
        )
        .await
    }

    /// Reads a supported image from a project-relative path.
    pub async fn read_project_image(
        this: Instance<Self>,
        project_id: String,
        path: String,
    ) -> Result<Vec<u8>, String> {
        Self::host_download(
            this,
            "files.image",
            json!({
                "projectId": project_id, "path": path,
            }),
        )
        .await
    }

    /// Saves image bytes through the native save dialog; returns `false` if canceled.
    pub async fn save_image(
        this: Instance<Self>,
        suggested_name: String,
        bytes: Vec<u8>,
    ) -> Result<bool, String> {
        let dialog = SaveDialog::new().file_name(sanitize_save_file_name(&suggested_name));
        let Some(path) = element::pick_save_path(dialog).await? else {
            return Ok(false);
        };
        let task = this.with(|pilo| pilo.executor.spawn(tokio::fs::write(path, bytes)));
        task.await
            .map_err(|error| format!("failed to save image: {error}"))?
            .map_err(|error| format!("failed to save file: {error}"))?;
        Ok(true)
    }

    /// Reads a local file the user pasted or dropped, given as its `file:` URL.
    pub async fn read_local_file(this: Instance<Self>, uri: String) -> Result<Vec<u8>, String> {
        let task = this.with(|pilo| {
            pilo.executor
                .spawn(async move { read_local_file(&uri).await })
        });
        task.await
            .map_err(|error| format!("failed to read file: {error}"))?
    }

    /// Starts or resumes a Pi chat and returns its ready process snapshot.
    pub async fn start_chat(
        this: Instance<Self>,
        input: NativeStartChatInput,
    ) -> Result<JsonValue, String> {
        let builtin_extensions = input.builtin_extensions.map(|extensions| {
            extensions
                .into_iter()
                .map(|extension| json!({"id": extension.id}))
                .collect::<Vec<_>>()
        });
        Self::host_call(
            this,
            "chat.start",
            json!({
                "projectId": input.project_id, "sessionKey": input.session_key,
                "sessionPath": input.session_path, "noSession": input.no_session,
                "builtinExtensions": builtin_extensions,
            }),
        )
        .await
    }

    /// Returns the Remote Host's live state (enabled, addresses, pairing, devices).
    pub async fn remote_host_state(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "remote.state", json!({})).await
    }

    /// Lists the machine's LAN IPs for the Remote Host address picker.
    pub async fn remote_lan_addresses(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "remote.lanAddresses", json!({})).await
    }

    /// Enables or disables the Remote Host.
    pub async fn remote_set_enabled(
        this: Instance<Self>,
        enabled: bool,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "remote.enabled.set", json!({"enabled": enabled})).await
    }

    /// Sets the Remote Host's listen port.
    pub async fn remote_set_port(this: Instance<Self>, port: f64) -> Result<JsonValue, String> {
        if !port.is_finite() || port.fract() != 0.0 || !(0.0..=65535.0).contains(&port) {
            return Err(format!("invalid port: {port}"));
        }
        Self::host_call(this, "remote.port.set", json!({"port": port as u16})).await
    }

    /// Replaces the Remote Host's access addresses and entry selection.
    pub async fn remote_set_addresses(
        this: Instance<Self>,
        addresses: JsonValue,
        entry_address_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "remote.addresses.set",
            json!({"addresses": addresses, "entryAddressId": entry_address_id}),
        )
        .await
    }

    /// Regenerates the Remote Host's pairing link.
    pub async fn remote_pairing_regenerate(
        this: Instance<Self>,
        scopes: String,
    ) -> Result<JsonValue, String> {
        let scopes: pilo_domain::RemoteScopes = scopes.parse().map_err(str::to_owned)?;
        Self::host_call(this, "remote.pairing.regenerate", json!({"scopes": scopes})).await
    }

    /// Revokes a paired Remote device.
    pub async fn remote_device_revoke(
        this: Instance<Self>,
        device_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "remote.device.revoke", json!({"deviceId": device_id})).await
    }

    /// Revokes every Remote device and invalidates the active pairing link.
    pub async fn remote_devices_revoke_all(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "remote.devices.revokeAll", json!({})).await
    }

    /// Updates the permissions of a paired Remote device.
    pub async fn remote_device_set_scopes(
        this: Instance<Self>,
        device_id: String,
        scopes: String,
    ) -> Result<JsonValue, String> {
        let scopes: pilo_domain::RemoteScopes = scopes.parse().map_err(str::to_owned)?;
        Self::host_call(
            this,
            "remote.devices.setScopes",
            json!({"deviceId": device_id, "scopes": scopes}),
        )
        .await
    }

    /// Renames a paired Remote device.
    pub async fn remote_device_rename(
        this: Instance<Self>,
        device_id: String,
        name: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "remote.device.rename",
            json!({"deviceId": device_id, "name": name}),
        )
        .await
    }

    /// Opens the app's log directory in the file manager, preferring nsh's `log_file` parent when set.
    pub async fn open_log_directory(
        this: Instance<Self>,
        log_file: Option<String>,
    ) -> Result<(), String> {
        let _ = this;
        let directory = resolve_log_directory(log_file.as_deref(), cfg!(debug_assertions))?;
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("creating log directory {directory:?} failed: {error}"))?;
        element::open_path(directory).await
    }

    /// Stops a Pi chat; stopping an absent session succeeds.
    pub async fn stop_chat(
        this: Instance<Self>,
        session_key: String,
        reason: Option<String>,
    ) -> Result<(), String> {
        Self::host_call(
            this,
            "chat.stop",
            json!({"sessionKey": session_key, "reason": reason}),
        )
        .await
    }

    /// Returns a live chat state, or null when none is available for the key.
    pub async fn chat_state(
        this: Instance<Self>,
        session_key: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "chat.state", json!({"sessionKey": session_key})).await
    }

    /// Captures persisted history and the live transcript at an ordered event cut.
    pub async fn chat_transcript_snapshot(
        this: Instance<Self>,
        session_key: String,
        window: Option<JsonValue>,
    ) -> Result<JsonValue, String> {
        Self::host_call(
            this,
            "chat.transcript",
            json!({"sessionKey": session_key, "window": window}),
        )
        .await
    }

    /// Sends a Pi RPC command; responses arrive independently on the event stream.
    pub async fn send_chat_command(
        this: Instance<Self>,
        session_key: String,
        command: JsonValue,
    ) -> Result<(), String> {
        Self::host_call(
            this,
            "chat.rpc",
            json!({"sessionKey": session_key, "command": command}),
        )
        .await
    }

    /// Loads the persisted read states across projects.
    pub async fn load_session_read_states(
        this: Instance<Self>,
    ) -> Result<Vec<NativeSessionReadState>, String> {
        Self::host_call(this, "session.readStates", json!({})).await
    }

    /// Acknowledges an observed session revision and returns the resulting read state.
    pub async fn mark_session_read(
        this: Instance<Self>,
        project_id: String,
        session_path: String,
        revision: f64,
    ) -> Result<NativeSessionReadState, String> {
        if !(1.0..=9_007_199_254_740_991.0).contains(&revision) || revision.fract() != 0.0 {
            return Err("session read revision must be a positive safe integer".into());
        }
        Self::host_call(
            this,
            "session.markRead",
            json!({
                "projectId": project_id, "sessionPath": session_path, "revision": revision as u64,
            }),
        )
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
        Self::host_call(this, "preferences.get", json!({})).await
    }

    /// Applies a partial patch and returns the complete, updated preferences.
    pub async fn save_preferences(
        this: Instance<Self>,
        patch: JsonValue,
        initial: Option<bool>,
    ) -> Result<NativePreferencesSnapshot, String> {
        if !patch.is_object() {
            return Err("Pilo preference patch must be an object".into());
        }
        Self::host_call(
            this,
            "preferences.patch",
            json!({"patch": patch, "initial": initial}),
        )
        .await
    }

    /// Reads the complete Host appearance settings, including tokens and conversion reports.
    pub async fn load_theme_settings(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::host_call(this, "theme.get", json!({})).await
    }

    /// Applies a Host appearance update and returns the complete settings.
    pub async fn save_theme_settings(
        this: Instance<Self>,
        update: JsonValue,
    ) -> Result<JsonValue, String> {
        if !update.is_object() {
            return Err("Pilo theme settings update must be an object".into());
        }
        Self::host_call(this, "theme.set", json!({"update": update})).await
    }

    /// Lists the installed font families with the platform's monospace trait.
    pub async fn system_font_families(this: Instance<Self>) -> Result<JsonValue, String> {
        Self::with_runtime(this, |runtime| async move {
            let families = system_font_families(&runtime).await?;
            serde_json::to_value(families).map_err(|error| error.to_string())
        })
        .await
    }

    /// Opens the project, or a path in it, in a desktop app: `finder`,
    /// `ghostty`, `rex`, `winc`, `explorer` or `powershell`.
    pub async fn project_open_in_app(
        this: Instance<Self>,
        project_id: String,
        app: String,
        path: Option<String>,
    ) -> Result<(), String> {
        let app: ProjectApp = serde_json::from_value(JsonValue::String(app))
            .map_err(|error| format!("unsupported app: {error}"))?;
        Self::with_runtime(this, move |runtime| async move {
            project_api::project_open_in_app(&runtime, project_id, app, path).await
        })
        .await
    }

    /// Opens a file link: returns `{ path, content }` when previewing text, or `null` after opening in the system app.
    pub async fn open_file_link(
        this: Instance<Self>,
        project_id: String,
        url: String,
        preview: bool,
    ) -> Result<Option<JsonValue>, String> {
        if preview {
            return Self::host_call(
                this,
                "project.file.preview",
                json!({"projectId": project_id, "url": url}),
            )
            .await;
        }
        Self::with_runtime(this, move |runtime| async move {
            project_api::project_file_link_open(&runtime, project_id, url, false).await?;
            Ok(None)
        })
        .await
    }

    /// Reads the project's Git branch and porcelain file statuses on its connection.
    pub async fn project_git_status(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<JsonValue, String> {
        Self::host_call(this, "git.status", json!({"projectId": project_id})).await
    }

    /// Reads a unified Git diff for a project (or one project-relative file path).
    pub async fn project_git_diff(
        this: Instance<Self>,
        project_id: String,
        path: Option<String>,
        staged: bool,
    ) -> Result<String, String> {
        Self::host_call(
            this,
            "git.diff",
            json!({"projectId": project_id, "path": path, "staged": staged}),
        )
        .await
    }

    /// Opens a shell in the project's environment and returns its terminal
    /// (`id`, `projectId`, `title`); its output comes from `next_terminal_events`.
    pub async fn open_terminal(
        this: Instance<Self>,
        project_id: String,
        cols: f64,
        rows: f64,
    ) -> Result<JsonValue, String> {
        let (cols, rows) = terminal_size(cols, rows)?;
        Self::host_call(
            this,
            "terminal.open",
            json!({"projectId": project_id, "cols": cols, "rows": rows}),
        )
        .await
    }

    /// Sends input bytes to a terminal.
    pub async fn write_terminal(
        this: Instance<Self>,
        terminal_id: String,
        data: Vec<u8>,
    ) -> Result<(), String> {
        Self::with_runtime(this, move |runtime| async move {
            host_api::call_binary(
                &runtime,
                &Principal::Local,
                "terminal.write",
                json!({"terminalId": terminal_id}),
                Some(&data),
            )
            .await
            .map_err(|err| err.message)?;
            Ok(())
        })
        .await
    }

    /// Changes a terminal's size in character cells.
    pub async fn resize_terminal(
        this: Instance<Self>,
        terminal_id: String,
        cols: f64,
        rows: f64,
    ) -> Result<(), String> {
        let (cols, rows) = terminal_size(cols, rows)?;
        Self::host_call(
            this,
            "terminal.resize",
            json!({"terminalId": terminal_id, "cols": cols, "rows": rows}),
        )
        .await
    }

    /// Closes a terminal and its shell; closing an absent one succeeds.
    pub async fn close_terminal(this: Instance<Self>, terminal_id: String) -> Result<(), String> {
        Self::host_call(this, "terminal.close", json!({"terminalId": terminal_id})).await
    }

    /// Waits for terminal events and returns up to `max` in order:
    /// `{ type: "output", terminalId, data }` with base64 `data`,
    /// `{ type: "exit", terminalId }` and `{ type: "error", terminalId, message }`.
    /// Returns an empty list once the runtime has shut down.
    pub async fn next_terminal_events(
        this: Instance<Self>,
        max: f64,
    ) -> Result<Vec<JsonValue>, String> {
        let max = positive_count(max, "terminal event batch size")?;
        let task = this.with(|pilo| {
            let events = pilo.terminal_events.clone();
            pilo.executor
                .spawn(async move { encode_terminal_events(events.next_batch(max).await) })
        });
        task.await
            .map_err(|error| format!("Pilo terminal event task failed: {error}"))
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
