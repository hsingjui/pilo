//! The desktop app this CLI belongs to: where it lives, how to start it, and
//! whether a running Host is that copy.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use pilo_ipc::{Endpoint, HostHello, Installation};
use serde_json::Value;

use crate::{client::Client, error::CliError};

/// How long a started app has to answer the hello.
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_INTERVAL: Duration = Duration::from_millis(200);

/// The app copy the PATH entry belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub source: String,
    pub path: PathBuf,
    /// What starts or activates it: a macOS bundle for `open -a`, else an executable.
    launcher: PathBuf,
}

impl App {
    /// The app holding this executable (resolving the PATH link), or the
    /// AppImage whose persistent CLI copy this is.
    pub fn current(app_id: &str) -> Result<Self, CliError> {
        let exe = std::env::current_exe()
            .map_err(|error| CliError::internal(format!("cannot locate this pilo: {error}")))?;
        let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
        Self::containing(&exe)
            .or_else(|| appimage_of_copy(&exe, app_id))
            .ok_or_else(|| {
                CliError::rejected(
                    "app_not_found",
                    format!(
                        "{} is not inside a Pilo app; install the CLI from the Pilo app's settings",
                        exe.display()
                    ),
                )
            })
    }

    /// The app whose `bin/` holds `exe`: `X.app/Contents/Resources/bin` on
    /// macOS, `<app dir>/bin` beside the app executable elsewhere.
    pub fn containing(exe: &Path) -> Option<Self> {
        let bin = exe.parent()?;
        if bin.file_name()? != "bin" {
            return None;
        }
        if cfg!(target_os = "macos") {
            let contents = bin.parent()?.parent()?;
            let bundle = contents.parent()?;
            let is_bundle = contents.file_name()? == "Contents"
                && bundle.extension().is_some_and(|ext| ext == "app")
                && contents.join("Info.plist").is_file();
            return is_bundle.then(|| Self {
                source: "installed".into(),
                path: bundle.to_path_buf(),
                launcher: bundle.to_path_buf(),
            });
        }
        let dir = bin.parent()?;
        let launcher = dir.join(format!("Pilo{}", std::env::consts::EXE_SUFFIX));
        if !launcher.is_file() {
            return None;
        }
        let installed = if cfg!(windows) {
            // Inno Setup keeps its uninstaller beside the app directory.
            dir.parent()
                .is_some_and(|parent| parent.join("unins000.exe").is_file())
        } else {
            dir.starts_with("/opt") || dir.starts_with("/usr")
        };
        Some(Self {
            source: if installed { "installed" } else { "portable" }.into(),
            path: dir.to_path_buf(),
            launcher,
        })
    }

    /// Starts the app, or brings an already running copy forward.
    pub fn launch(&self) -> Result<(), CliError> {
        let failed = |error: String| {
            CliError::offline_code(
                "launch_failed",
                format!(
                    "could not start Pilo at {}: {error}; start it with `pilo open`, or reinstall the app",
                    self.path.display()
                ),
            )
        };
        if !self.launcher.exists() {
            return Err(CliError::rejected(
                "app_not_found",
                format!(
                    "the Pilo app at {} is missing; reinstall it or repair the CLI in its settings",
                    self.path.display()
                ),
            ));
        }
        if cfg!(target_os = "macos") {
            let output = Command::new("/usr/bin/open")
                .arg("-a")
                .arg(&self.launcher)
                .stdin(Stdio::null())
                .output()
                .map_err(|error| failed(error.to_string()))?;
            if !output.status.success() {
                let reason = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(failed(if reason.is_empty() {
                    format!("open exited with {}", output.status)
                } else {
                    reason
                }));
            }
            return Ok(());
        }
        let mut command = Command::new(&self.launcher);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(dir) = self.launcher.parent() {
            command.current_dir(dir);
        }
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        command
            .spawn()
            .map(drop)
            .map_err(|error| failed(error.to_string()))
    }

    /// Refuses a Host that runs from another copy with the same app ID.
    pub fn verify(&self, hello: &HostHello) -> Result<(), CliError> {
        let Some(running) = &hello.installation else {
            return Err(CliError::rejected(
                "installation_mismatch",
                "the running Pilo does not report where it is installed; quit it and run `pilo open`",
            ));
        };
        if running.source == self.source && same_path(Path::new(&running.path), &self.path) {
            return Ok(());
        }
        Err(CliError::rejected(
            "installation_mismatch",
            format!(
                "another Pilo copy with this app ID is running from {} ({}), but this pilo belongs to {} ({}); quit the running copy, then run `pilo open` again",
                running.path,
                running.source,
                self.path.display(),
                self.source
            ),
        ))
    }

    /// Connects to this app's Host, starting it first when it is not running,
    /// and checks that the Host is this copy. Retries only connect and hello.
    pub async fn connect(
        &self,
        endpoint: &Endpoint,
        timeout: Duration,
        activate: bool,
    ) -> Result<Client, CliError> {
        match Client::connect(endpoint, timeout).await {
            Ok(client) => {
                self.verify(client.hello())?;
                if activate {
                    self.launch()?;
                }
                return Ok(client);
            }
            Err(error) if error.category == crate::error::Category::Offline => {}
            Err(error) => return Err(error),
        }
        self.launch()?;
        let deadline = Instant::now() + LAUNCH_TIMEOUT;
        let client = loop {
            match Client::connect(endpoint, timeout).await {
                Ok(client) => break client,
                Err(error) if error.category == crate::error::Category::Offline => {
                    if Instant::now() >= deadline {
                        return Err(CliError::offline_code(
                            "launch_timeout",
                            format!(
                                "Pilo was started from {} but did not answer within {} seconds ({}); run `pilo open` and try again",
                                self.path.display(),
                                LAUNCH_TIMEOUT.as_secs(),
                                error.message
                            ),
                        ));
                    }
                    tokio::time::sleep(RETRY_INTERVAL).await;
                }
                Err(error) => return Err(error),
            }
        };
        self.verify(client.hello())?;
        Ok(client)
    }

    pub fn installation(&self) -> Installation {
        Installation {
            source: self.source.clone(),
            path: self.path.to_string_lossy().into_owned(),
        }
    }
}

/// The AppImage the desktop app recorded when it put this persistent copy on the PATH.
fn appimage_of_copy(exe: &Path, app_id: &str) -> Option<App> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let home = std::env::home_dir()?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".local/share"));
    let record: Value =
        serde_json::from_slice(&std::fs::read(data.join(app_id).join("cli-install.json")).ok()?)
            .ok()?;
    let copy = record["copy"].as_str()?;
    let installation = &record["installation"];
    if !same_path(Path::new(copy), exe) || installation["source"] != "appimage" {
        return None;
    }
    let image = PathBuf::from(installation["path"].as_str()?);
    Some(App {
        source: "appimage".into(),
        launcher: image.clone(),
        path: image,
    })
}

/// Compares paths after resolving them, case-insensitively on Windows.
pub fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let text = resolved.to_string_lossy();
        let text = text.trim_end_matches(['/', '\\']);
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text.to_owned()
        }
    };
    normalize(left) == normalize(right)
}
