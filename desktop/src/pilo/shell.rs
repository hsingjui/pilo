//! The runtime's host ports as the nsh shell implements them: paths, events, web assets and the folder picker.

use std::{
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use nsh_core::JsonValue;
use pilo_runtime::{
    handle::HostShell,
    host_events::HostEvents,
    tasks,
    web_assets::{WebAsset, WebAssets},
};
use tokio::runtime::Runtime as Executor;

pub(super) struct ShellEvents;

impl HostEvents for ShellEvents {
    fn emit(&self, _name: &str, _payload: JsonValue) -> Result<(), String> {
        Ok(())
    }
}

pub(super) struct ShellWebAssets(pub(super) PathBuf);

/// The nsh host's shell: a native folder picker and a cache under the data dir.
pub(super) struct NshHostShell {
    pub(super) cache_dir: PathBuf,
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

/// The app's log directory, as the Tauri `appLogDir` resolves it.
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
