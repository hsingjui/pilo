//! Puts the CLI bundled with the app on the user's PATH: detection, install,
//! uninstall and repair for the desktop settings' CLI page.
//!
//! macOS links `/usr/local/bin/<command>` with one administrator prompt and
//! falls back to `~/.local/bin` when it is canceled. Linux links
//! `~/.local/bin/<command>`; an AppImage links a persistent copy instead of its
//! temporary mount. Windows adds the app's `bin` directory to the user PATH.
//! What Pilo created is recorded per app ID, so nothing it did not create is
//! overwritten or removed.

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use nsh_core::{JsonValue, prelude::*};
use serde::{Deserialize, Serialize};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

const RELEASE_APP_ID: &str = "app.hsingjui.pilo";
const DEV_APP_ID: &str = "app.hsingjui.pilo.dev";
const RECORD_FILE: &str = "cli-install.json";
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

/// Installs the app's bundled CLI on the PATH.
#[module]
pub(crate) struct DesktopCli;

#[module]
impl DesktopCli {
    /// The CLI's install state for the app with manifest ID `appId`.
    pub async fn status(app_id: String) -> Result<JsonValue, String> {
        run(move || Ok(Installer::current(&app_id)?.status())).await
    }

    /// Installs the CLI entry; idempotent. The result's `outcome` is
    /// `installed`, `fallback` (macOS authorization canceled, installed in
    /// `~/.local/bin`) or `conflict`.
    pub async fn install(app_id: String) -> Result<JsonValue, String> {
        run(move || Installer::current(&app_id)?.install(false)).await
    }

    /// Points the recorded entry at this app again (moved, updated or switched copy).
    pub async fn repair(app_id: String) -> Result<JsonValue, String> {
        run(move || Installer::current(&app_id)?.install(true)).await
    }

    /// Removes only what Pilo created; `outcome` is `canceled` when macOS
    /// authorization was canceled and the link was left in place.
    pub async fn uninstall(app_id: String) -> Result<JsonValue, String> {
        run(move || Installer::current(&app_id)?.uninstall()).await
    }

    /// At launch, refreshes an installed AppImage's persistent CLI copy when it
    /// belongs to this AppImage and its version differs. Returns whether it changed.
    pub async fn sync_on_launch(app_id: String) -> Result<JsonValue, String> {
        run(move || Installer::current(&app_id)?.sync_on_launch()).await
    }
}

async fn run<T: Serialize + Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<JsonValue, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("pilo-cli-install".into())
        .spawn(move || {
            let _ =
                tx.send(task().and_then(|value| {
                    serde_json::to_value(value).map_err(|error| error.to_string())
                }));
        })
        .map_err(|error| format!("could not start the CLI installer: {error}"))?;
    rx.await
        .map_err(|_| "the CLI installer stopped unexpectedly".to_owned())?
}

/// The command name a package installs: `pilo`, or `pilo-dev` for the dev app.
pub(crate) fn command_name(app_id: &str) -> String {
    let name = if app_id.ends_with(".dev") {
        "pilo-dev"
    } else {
        "pilo"
    };
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// Where the running app lives: `installed`, `portable` or `appimage`, with
/// the .app bundle, app directory or original AppImage file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Installation {
    pub source: String,
    pub path: PathBuf,
}

/// What Pilo created for one app ID.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Record {
    /// The symlink Pilo created (macOS/Linux).
    pub link: Option<PathBuf>,
    /// What that symlink pointed at when created.
    pub link_target: Option<PathBuf>,
    /// The AppImage's persistent copy the link points at.
    pub copy: Option<PathBuf>,
    /// What Pilo wrote to `copy`, so another file there is never run, replaced or removed.
    pub copy_fingerprint: Option<Fingerprint>,
    /// The PATH directory the entry relies on (Windows: the app's `bin`).
    pub path_entry: Option<PathBuf>,
    /// Whether Pilo added `path_entry` to the user PATH.
    pub path_entry_added: bool,
    /// The exact user PATH entry Pilo inserted; only this entry is ever removed.
    pub path_entry_raw: Option<String>,
    pub installation: Option<Installation>,
}

/// The PATH value's `;`-separated segments exactly as written, empty ones included.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn path_segments(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    value.split(';').map(str::to_owned).collect()
}

/// Appends `raw`, keeping a trailing `;` where it was.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn insert_path_entry(segments: &mut Vec<String>, raw: &str) {
    match segments.last() {
        Some(last) if last.is_empty() => segments.insert(segments.len() - 1, raw.to_owned()),
        _ => segments.push(raw.to_owned()),
    }
}

/// Removes the one segment spelled exactly as Pilo inserted it, keeping
/// equivalent entries the user added themselves and every other segment as is.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn remove_path_entry(segments: &mut Vec<String>, raw: &str) -> bool {
    match segments.iter().position(|segment| segment == raw) {
        Some(index) => {
            segments.remove(index);
            true
        }
        None => false,
    }
}

/// A file's size and SHA-256.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fingerprint {
    pub size: u64,
    pub sha256: String,
}

impl Fingerprint {
    pub(crate) fn of_bytes(bytes: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(bytes);
        Self {
            size: bytes.len() as u64,
            sha256: digest.iter().map(|byte| format!("{byte:02x}")).collect(),
        }
    }

    /// The fingerprint of a regular file (not a symlink); `None` otherwise.
    pub(crate) fn of_file(path: &Path) -> Option<Self> {
        let metadata = std::fs::symlink_metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        std::fs::read(path).ok().map(|bytes| Self::of_bytes(&bytes))
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub command: String,
    /// `unavailable`, `not_installed`, `ready`, `not_in_path`, `stale` or `conflict`.
    pub state: &'static str,
    /// Why a `stale` entry needs repair: `missing`, `moved`, `other_app`,
    /// `outdated` or `path_removed`.
    pub reason: Option<&'static str>,
    pub bundled_path: Option<PathBuf>,
    pub bundled_version: Option<String>,
    pub entry_path: Option<PathBuf>,
    pub entry_target: Option<PathBuf>,
    pub installed_version: Option<String>,
    /// The directory that has to be on PATH for the entry to run.
    pub path_dir: Option<PathBuf>,
    pub shadowed_by: Option<PathBuf>,
    pub conflict_path: Option<PathBuf>,
    pub installation: Option<Installation>,
    /// Set by actions: `installed`, `fallback`, `conflict`, `uninstalled` or `canceled`.
    pub outcome: Option<&'static str>,
}

/// The ways an elevated operation ends without succeeding.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ElevateError {
    Canceled,
    /// The entry changed while authorization was pending; nothing was touched.
    Conflict,
    Failed(String),
}

pub(crate) type Elevate = Box<dyn Fn(&str) -> Result<(), ElevateError> + Send>;

/// Everything the installer reads from the environment, so tests can supply it.
pub(crate) struct Installer {
    pub app_id: String,
    pub command: String,
    pub bundled: Option<PathBuf>,
    pub installation: Option<Installation>,
    /// The directory holding each app ID's record.
    pub data_base: PathBuf,
    /// The PATH directories a new terminal searches, in order.
    pub path_dirs: Vec<PathBuf>,
    /// macOS `/usr/local/bin`, linked with authorization when not writable.
    pub system_dir: Option<PathBuf>,
    /// `~/.local/bin`.
    pub user_dir: PathBuf,
    /// The AppImage persistent copy directory, `~/.local/share/pilo/bin`.
    pub copy_dir: Option<PathBuf>,
    pub elevate: Elevate,
}

impl Installer {
    fn record_path_for(&self, app_id: &str) -> PathBuf {
        self.data_base.join(app_id).join(RECORD_FILE)
    }

    pub(crate) fn load_record(&self) -> Option<Record> {
        read_record(&self.record_path_for(&self.app_id))
    }

    fn save_record(&self, record: &Record) -> Result<(), String> {
        let path = self.record_path_for(&self.app_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("creating {parent:?} failed: {error}"))?;
        }
        let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
        write_atomically(&path, &bytes, false)
    }

    fn clear_record(&self) -> Result<(), String> {
        match std::fs::remove_file(self.record_path_for(&self.app_id)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("removing the CLI install record failed: {error}"))
            }
            _ => Ok(()),
        }
    }

    /// The records of the other app IDs (dev beside release).
    #[cfg(windows)]
    fn other_records(&self) -> Vec<Record> {
        [RELEASE_APP_ID, DEV_APP_ID]
            .into_iter()
            .filter(|id| *id != self.app_id)
            .filter_map(|id| read_record(&self.record_path_for(id)))
            .collect()
    }

    fn base_status(&self) -> Status {
        Status {
            command: self.command.clone(),
            bundled_path: self.bundled.clone(),
            bundled_version: self.bundled.as_deref().and_then(cli_version),
            installation: self.installation.clone(),
            ..Status::default()
        }
    }

    /// The first PATH match for the command that is not `entry_dir`.
    fn shadowing(&self, entry_dir: &Path) -> Option<PathBuf> {
        for dir in &self.path_dirs {
            let candidate = dir.join(&self.command);
            if !is_executable_file(&candidate) {
                continue;
            }
            return (!same_path(dir, entry_dir)).then_some(candidate);
        }
        None
    }

    fn in_path(&self, dir: &Path) -> bool {
        self.path_dirs.iter().any(|entry| same_path(entry, dir))
    }

    pub(crate) fn same_installation(&self, record: &Record) -> bool {
        match (&record.installation, &self.installation) {
            (Some(recorded), Some(current)) => {
                recorded.source == current.source && same_path(&recorded.path, &current.path)
            }
            _ => false,
        }
    }

    pub(crate) fn status(&self) -> Status {
        let mut status = self.base_status();
        let Some(record) = self.load_record() else {
            status.state = if self.bundled.is_none() {
                "unavailable"
            } else {
                "not_installed"
            };
            self.check_default_conflict(&mut status);
            return status;
        };
        self.record_status(&record, &mut status);
        status
    }
}

fn read_record(path: &Path) -> Option<Record> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Writes through a sibling temporary file and a rename, so readers see the old or new file.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8], executable: bool) -> Result<(), String> {
    let temporary = write_temporary(path, bytes, executable)?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("replacing {path:?} failed: {error}")
    })
}

/// Writes `bytes` to a temporary file beside `path`.
fn write_temporary(path: &Path, bytes: &[u8], executable: bool) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{path:?} has no parent directory"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        std::fs::write(&temporary, bytes)
            .map_err(|error| format!("writing {temporary:?} failed: {error}"))?;
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("making {temporary:?} executable failed: {error}"))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(temporary),
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(error)
        }
    }
}

/// Writes `bytes` to `path` only if nothing is there: a sibling temporary file
/// is hard-linked into place, which fails instead of replacing. `Ok(false)`
/// means something already exists at `path`.
pub(crate) fn write_new(path: &Path, bytes: &[u8], executable: bool) -> Result<bool, String> {
    let temporary = write_temporary(path, bytes, executable)?;
    let placed = std::fs::hard_link(&temporary, path);
    let _ = std::fs::remove_file(&temporary);
    match placed {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("placing {path:?} failed: {error}")),
    }
}

/// Runs `<cli> version` and returns its `cli` field; `None` when it fails or prints something else.
pub(crate) fn cli_version(path: &Path) -> Option<String> {
    let output = run_with_timeout(Command::new(path).arg("version"), VERSION_TIMEOUT)?;
    let value: JsonValue = serde_json::from_str(output.trim()).ok()?;
    value.get("cli")?.as_str().map(str::to_owned)
}

/// Runs a command with null stdin and returns its stdout if it exits 0 in time.
pub(crate) fn run_with_timeout(command: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let text = reader.join().ok()?;
    status.success().then_some(text)
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

/// Compares paths after resolving them, case-insensitively on Windows.
pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let text = resolved.to_string_lossy().into_owned();
        let text = text.trim_end_matches(['/', '\\']).to_owned();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    normalize(left) == normalize(right)
}

/// The app's install location and source, from the running executable.
pub(crate) fn current_installation() -> Option<Installation> {
    let exe = std::env::current_exe().ok()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let dir = exe.parent()?.to_path_buf();
    if cfg!(target_os = "macos") {
        // .../Pilo.app/Contents/MacOS/Pilo
        let bundle = dir.parent()?.parent()?.to_path_buf();
        let source = if bundle.extension().is_some_and(|ext| ext == "app") {
            "installed"
        } else {
            "portable"
        };
        return Some(Installation {
            source: source.into(),
            path: bundle,
        });
    }
    if cfg!(target_os = "linux")
        && let Some(image) = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    {
        let image = std::fs::canonicalize(&image).unwrap_or(image);
        return Some(Installation {
            source: "appimage".into(),
            path: image,
        });
    }
    let installed = if cfg!(windows) {
        // Inno Setup keeps its uninstaller beside the `pilo-app` directory.
        dir.parent()
            .is_some_and(|parent| parent.join("unins000.exe").is_file())
    } else {
        dir.starts_with("/opt") || dir.starts_with("/usr")
    };
    Some(Installation {
        source: if installed { "installed" } else { "portable" }.into(),
        path: dir,
    })
}

/// The CLI bundled with the running app: `bin/` in the app resources, the
/// workspace build in debug, or `PILO_CLI_BINARY` when set.
fn bundled_cli(command: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PILO_CLI_BINARY")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
    {
        return is_executable_file(&path).then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let dir = exe.parent()?;
    let packaged = if cfg!(target_os = "macos") {
        dir.join("../Resources/bin").join(command)
    } else {
        dir.join("bin").join(command)
    };
    if is_executable_file(&packaged) {
        return Some(std::fs::canonicalize(&packaged).unwrap_or(packaged));
    }
    if cfg!(debug_assertions) {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest_dir
            .ancestors()
            .find(|dir| dir.join("Cargo.toml").is_file() && dir.join("nsh.json").is_file())?;
        let built = workspace
            .join("target/debug/pilo")
            .with_extension(std::env::consts::EXE_EXTENSION);
        return is_executable_file(&built).then_some(built);
    }
    None
}

/// The parent of each app ID's data directory, as the desktop host lays them out.
fn data_base(home: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Application Support"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| Some(home.join(".local/share")))
    }
}

impl Installer {
    /// The installer for the running app.
    fn current(app_id: &str) -> Result<Self, String> {
        if app_id != RELEASE_APP_ID && app_id != DEV_APP_ID {
            return Err(format!("unknown Pilo app ID: {app_id}"));
        }
        let home = std::env::home_dir().ok_or("cannot resolve the home directory")?;
        let command = command_name(app_id);
        let installation = current_installation();
        let appimage = installation
            .as_ref()
            .is_some_and(|installation| installation.source == "appimage");
        Ok(Self {
            app_id: app_id.to_owned(),
            bundled: bundled_cli(&command),
            command,
            installation,
            data_base: data_base(&home).ok_or("cannot resolve the Pilo data directory")?,
            path_dirs: terminal_path_dirs(),
            system_dir: cfg!(target_os = "macos").then(|| PathBuf::from("/usr/local/bin")),
            user_dir: home.join(".local/bin"),
            copy_dir: appimage.then(|| home.join(".local/share/pilo/bin")),
            elevate: Box::new(elevate),
        })
    }
}

#[cfg(unix)]
use unix::{elevate, terminal_path_dirs};
#[cfg(windows)]
use windows::terminal_path_dirs;

#[cfg(windows)]
fn elevate(_: &str) -> Result<(), ElevateError> {
    Err(ElevateError::Failed(
        "authorization is not used on Windows".into(),
    ))
}

#[cfg(test)]
mod tests;
