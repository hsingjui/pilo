//! The runtime's host ports as the nsh shell implements them: paths, logging, web assets, desktop settings and the folder picker.

use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use log::{Level, LevelFilter, Log, Metadata, Record};
use nsh_core::JsonValue;
use pilo_runtime::{
    handle::{HostSettingFuture, HostShell},
    host_events::HostEvents,
    host_paths::HostPaths,
    storage, tasks,
    web_assets::{WebAsset, WebAssets},
};
use serde_json::json;
use tokio::runtime::Runtime as Executor;

/// No-op host event sink: desktop events use `EventStream` and `TerminalEventStream`.
pub(super) struct ShellEvents;

impl HostEvents for ShellEvents {
    fn emit(&self, _name: &str, _payload: JsonValue) -> Result<(), String> {
        Ok(())
    }
}

pub(super) struct ShellWebAssets(pub(super) PathBuf);

/// The nsh host's shell: a native folder picker, desktop settings and a cache under the data dir.
pub(super) struct NshHostShell {
    pub(super) cache_dir: PathBuf,
    pub(super) paths: HostPaths,
}

impl HostShell for NshHostShell {
    fn cache_dir(&self) -> Result<PathBuf, String> {
        Ok(self.cache_dir.clone())
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        open_path(path)
    }

    fn pick_directory(&self) -> Option<String> {
        rfd::FileDialog::new()
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn desktop_setting(&self, key: String, value: Option<JsonValue>) -> HostSettingFuture {
        let paths = self.paths.clone();
        Box::pin(async move {
            match key.as_str() {
                "desktop.exitOnClose" => {
                    tokio::task::spawn_blocking(move || match value {
                        None => {
                            let db = storage::open(&paths)?;
                            Ok(json!(storage::get_exit_on_close(&db)?))
                        }
                        Some(raw) => {
                            let enabled = raw
                                .as_bool()
                                .ok_or_else(|| "desktop.exitOnClose must be a boolean".to_owned())?;
                            let db = storage::open(&paths)?;
                            storage::set_exit_on_close(&db, enabled)?;
                            Ok(json!(enabled))
                        }
                    })
                    .await
                    .map_err(|error| format!("desktop setting task failed: {error}"))?
                }
                "desktop.showShortcut" => match value {
                    None => tokio::task::spawn_blocking(move || {
                        let db = storage::open(&paths)?;
                        Ok(json!(storage::get_show_shortcut(&db)?))
                    })
                    .await
                    .map_err(|error| format!("desktop setting task failed: {error}"))?,
                    Some(_) => Err(
                        "desktop.showShortcut must be changed in the desktop app settings so the OS registers the shortcut"
                            .to_owned(),
                    ),
                },
                "desktop.autostart" => Err(
                    "desktop.autostart is managed by the OS login service; change it in the desktop app settings"
                        .to_owned(),
                ),
                _ => Err(format!("unknown desktop setting: {key}")),
            }
        })
    }
}

/// Opens a file or directory in the file manager.
pub(super) fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("opening {path:?} failed: {error}"))
}

/// The app's log directory, keeping the existing platform log location.
pub(super) fn log_directory(development: bool) -> Result<PathBuf, String> {
    let identifier = data_identifier(development);
    #[cfg(target_os = "macos")]
    let base = std::env::home_dir()
        .ok_or("cannot resolve the home directory")?
        .join("Library/Logs");
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .map_err(|error| format!("cannot resolve APPDATA: {error}"))?;
    #[cfg(target_os = "linux")]
    let base = std::env::home_dir()
        .ok_or("cannot resolve the home directory")?
        .join(".local/share");
    Ok(base.join(identifier))
}

/// Resolves the directory to open for logs, preferring nsh's packaged `process.logFile` parent when provided.
pub(super) fn resolve_log_directory(
    log_file: Option<&str>,
    development: bool,
) -> Result<PathBuf, String> {
    if let Some(parent) = log_file
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(Path::new)
        .and_then(Path::parent)
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        return Ok(parent.to_path_buf());
    }
    log_directory(development)
}

/// Maximum size of the active log file before rotating to `pilo.log.1`.
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const LOG_FILE_NAME: &str = "pilo.log";
const LOG_BACKUP_NAME: &str = "pilo.log.1";

struct LogFileWriter {
    dir: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    written: u64,
}

impl LogFileWriter {
    fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            dir,
            max_bytes: max_bytes.max(1),
            file: None,
            written: 0,
        }
    }

    fn write_line(&mut self, line: &str) {
        let bytes = line.as_bytes();
        if self.file.is_none() {
            if std::fs::create_dir_all(&self.dir).is_err() {
                return;
            }
            let path = self.dir.join(LOG_FILE_NAME);
            let existing_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
                return;
            };
            self.written = existing_len;
            self.file = Some(file);
        }
        if self.written > 0 && self.written.saturating_add(bytes.len() as u64) > self.max_bytes {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut()
            && file.write_all(bytes).is_ok()
        {
            self.written = self.written.saturating_add(bytes.len() as u64);
        }
    }

    fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }

    fn rotate(&mut self) {
        self.file = None;
        let current = self.dir.join(LOG_FILE_NAME);
        let backup = self.dir.join(LOG_BACKUP_NAME);
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(&current, &backup);
        if let Ok(file) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&current)
        {
            self.file = Some(file);
            self.written = 0;
        }
    }
}

struct FileLogger {
    writer: Mutex<LogFileWriter>,
}

fn is_pilo_log_target(target: &str) -> bool {
    matches!(
        target,
        "runtime-diagnostics"
            | "connection-diagnostics"
            | "session-watcher"
            | "remote-webui"
            | "remote-http"
            | "pilo-server"
            | "shutdown"
            | "terminal"
            | "cache-keep-alive"
            | "session-history"
            | "chat-cache"
    ) || target.starts_with("pilo_")
        || target.starts_with("pilo::")
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Warn
            || (metadata.level() <= Level::Info && is_pilo_log_target(metadata.target()))
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let line = format!(
            "{ts_ms} [{}] [{}] {}\n",
            record.level(),
            record.target(),
            record.args()
        );
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        writer.write_line(&line);
    }

    fn flush(&self) {
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        writer.flush();
    }
}

/// Installs the rolling file logger once when the host has not already installed a `log` logger.
pub(super) fn init_file_logger(log_dir: PathBuf) {
    static LOGGER: OnceLock<FileLogger> = OnceLock::new();
    let mut initialized = false;
    let logger = LOGGER.get_or_init(|| {
        initialized = true;
        FileLogger {
            writer: Mutex::new(LogFileWriter::new(log_dir, MAX_LOG_FILE_BYTES)),
        }
    });
    if initialized && log::set_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

/// Resolves the packaged `pilo-server` resource filename for the compiled desktop target.
pub(super) fn server_resource_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "pilo-server-darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "pilo-server-darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "pilo-server-linux-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "pilo-server-linux-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "pilo-server-windows-x86_64.exe"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        "pilo-server"
    }
}

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

pub(super) fn workspace() -> Result<&'static Path, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    // nsh may generate the manifest under desktop/.nsh instead of using desktop/.
    manifest_dir
        .ancestors()
        .find(|dir| dir.join("Cargo.toml").is_file() && dir.join("pnpm-workspace.yaml").is_file())
        .ok_or_else(|| {
            format!(
                "could not locate the Pilo workspace from {}",
                manifest_dir.display()
            )
        })
}

pub(super) fn data_identifier(development: bool) -> &'static str {
    if development {
        "app.hsingjui.pilo.dev"
    } else {
        "app.hsingjui.pilo"
    }
}

pub(super) fn default_data_dir(home: &Path, development: bool) -> PathBuf {
    home.join("Library/Application Support")
        .join(data_identifier(development))
}

pub(super) fn executor() -> Result<&'static Executor, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_tauri_data_locations() {
        let home = Path::new("/Users/example");
        for (development, identifier) in [
            (false, "app.hsingjui.pilo"),
            (true, "app.hsingjui.pilo.dev"),
        ] {
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
    fn resolves_log_directory_from_nsh_log_file_when_present() {
        let dir = resolve_log_directory(Some("/tmp/pilo-logs/app.log"), true).unwrap();
        assert_eq!(dir, PathBuf::from("/tmp/pilo-logs"));
        assert_eq!(
            resolve_log_directory(None, true).unwrap(),
            log_directory(true).unwrap()
        );
        assert_eq!(
            resolve_log_directory(Some("  "), false).unwrap(),
            log_directory(false).unwrap()
        );
    }

    #[test]
    fn file_log_writer_creates_and_rotates_log_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = LogFileWriter::new(dir.path().to_path_buf(), 20);
        writer.write_line("first line 01234\n");
        writer.write_line("second line 5678\n");
        writer.flush();

        let backup = std::fs::read_to_string(dir.path().join(LOG_BACKUP_NAME)).unwrap();
        let active = std::fs::read_to_string(dir.path().join(LOG_FILE_NAME)).unwrap();
        assert_eq!(backup, "first line 01234\n");
        assert_eq!(active, "second line 5678\n");
    }

    #[test]
    fn desktop_setting_reads_and_writes_exit_on_close_and_reports_os_managed_keys() {
        let dir = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(dir.path().to_path_buf(), dir.path().to_path_buf()).unwrap();
        let shell = NshHostShell {
            cache_dir: dir.path().join("cache"),
            paths,
        };
        let rt = executor().unwrap();
        rt.block_on(async {
            assert_eq!(
                shell
                    .desktop_setting("desktop.exitOnClose".into(), None)
                    .await
                    .unwrap(),
                json!(false)
            );
            assert_eq!(
                shell
                    .desktop_setting("desktop.exitOnClose".into(), Some(json!(true)))
                    .await
                    .unwrap(),
                json!(true)
            );
            assert_eq!(
                shell
                    .desktop_setting("desktop.exitOnClose".into(), None)
                    .await
                    .unwrap(),
                json!(true)
            );
            assert!(
                shell
                    .desktop_setting("desktop.exitOnClose".into(), Some(json!("yes")))
                    .await
                    .is_err()
            );
            assert_eq!(
                shell
                    .desktop_setting("desktop.showShortcut".into(), None)
                    .await
                    .unwrap(),
                json!(pilo_domain::DEFAULT_SHOW_SHORTCUT)
            );
            assert!(
                shell
                    .desktop_setting("desktop.showShortcut".into(), Some(json!("mod+alt+k")))
                    .await
                    .unwrap_err()
                    .contains("desktop app settings")
            );
            assert!(
                shell
                    .desktop_setting("desktop.autostart".into(), None)
                    .await
                    .unwrap_err()
                    .contains("OS login service")
            );
        });
    }

    // Windows creates symlinks only with Developer Mode or admin rights.
    #[cfg(unix)]
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
