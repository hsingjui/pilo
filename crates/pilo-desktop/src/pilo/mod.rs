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
use tokio::{runtime::Runtime as Executor, sync::Mutex};

mod credentials;
mod encode;
mod host;
mod objects;
mod shell;

use encode::{encode_event_batch, encode_terminal_events, positive_count};
#[cfg(test)]
use host::CLOSED;
use host::{Host, run_with_runtime, stop_host};
use objects::NativeDesktopSettings;
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

    /// Calls a Host API JSON method on the embedded local runtime.
    pub async fn call(
        this: Instance<Self>,
        method: String,
        params: JsonValue,
    ) -> Result<JsonValue, String> {
        if method == "host.shutdown" {
            Self::shutdown(this).await?;
            return Ok(JsonValue::Null);
        }
        Self::with_runtime(this, move |runtime| async move {
            host_api::call(&runtime, &Principal::Local, &method, params)
                .await
                .map_err(|err| err.message)
        })
        .await
    }

    /// Calls a Host API binary-input method on the embedded local runtime.
    pub async fn upload(
        this: Instance<Self>,
        method: String,
        params: JsonValue,
        data: Vec<u8>,
    ) -> Result<JsonValue, String> {
        Self::with_runtime(this, move |runtime| async move {
            match host_api::call_binary(&runtime, &Principal::Local, &method, params, Some(&data))
                .await
                .map_err(|err| err.message)?
            {
                BinaryOutput::Json(value) => Ok(value),
                BinaryOutput::Bytes(_) => Err("expected a Host API JSON upload result".into()),
            }
        })
        .await
    }

    /// Calls a Host API binary-output method on the embedded local runtime.
    pub async fn download(
        this: Instance<Self>,
        method: String,
        params: JsonValue,
    ) -> Result<Vec<u8>, String> {
        Self::with_runtime(this, move |runtime| async move {
            match host_api::call_binary(&runtime, &Principal::Local, &method, params, None)
                .await
                .map_err(|err| err.message)?
            {
                BinaryOutput::Bytes(bytes) => Ok(bytes),
                BinaryOutput::Json(_) => Err("expected a Host API binary result".into()),
            }
        })
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

    /// Opens a project file link in the system app.
    pub async fn open_file_link(
        this: Instance<Self>,
        project_id: String,
        url: String,
    ) -> Result<(), String> {
        Self::with_runtime(this, move |runtime| async move {
            project_api::project_file_link_open(&runtime, project_id, url, false).await?;
            Ok(())
        })
        .await
    }

    /// Reads the saved device token for a paired remote Host; `null` when none is saved.
    pub async fn remote_host_token(
        this: Instance<Self>,
        host_id: String,
    ) -> Result<Option<String>, String> {
        let task = this.with(|pilo| {
            pilo.executor
                .spawn_blocking(move || credentials::get_remote_host_token(&host_id))
        });
        task.await
            .map_err(|error| format!("failed to read the remote Host token: {error}"))?
    }

    /// Saves the device token for a paired remote Host in the system credential store.
    pub async fn save_remote_host_token(
        this: Instance<Self>,
        host_id: String,
        token: String,
    ) -> Result<(), String> {
        let task = this.with(|pilo| {
            pilo.executor
                .spawn_blocking(move || credentials::set_remote_host_token(&host_id, &token))
        });
        task.await
            .map_err(|error| format!("failed to save the remote Host token: {error}"))?
    }

    /// Deletes the saved device token for a remote Host; deleting an absent one succeeds.
    pub async fn delete_remote_host_token(
        this: Instance<Self>,
        host_id: String,
    ) -> Result<(), String> {
        let task = this.with(|pilo| {
            pilo.executor
                .spawn_blocking(move || credentials::delete_remote_host_token(&host_id))
        });
        task.await
            .map_err(|error| format!("failed to delete the remote Host token: {error}"))?
    }

    /// The machine's host name, used to name this desktop when pairing with a remote Host.
    pub fn machine_name(&self) -> Option<String> {
        credentials::machine_name()
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
