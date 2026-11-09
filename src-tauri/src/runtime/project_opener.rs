use std::{path::PathBuf, time::Duration};

use serde::Deserialize;
use tokio::{process::Command, time::timeout};

use crate::domain::{ConnectionKind, Project};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectApp {
    Explorer,
    Powershell,
    Finder,
    Ghostty,
    Winc,
}

async fn winc_windows_executable() -> PathBuf {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join("Programs/winc/winc.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path).filter(|path| path.is_absolute()) {
            candidates.push(directory.join("winc.exe"));
            // Winc's installer puts bin/winc.cmd on PATH; launch the sibling exe directly.
            if directory
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
            {
                candidates.push(directory.join("../winc.exe"));
            }
        }
    }
    for candidate in candidates {
        if tokio::fs::metadata(&candidate)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            return candidate;
        }
    }
    "winc.exe".into()
}

pub(crate) async fn open(
    project: &Project,
    app: ProjectApp,
    path: Option<&str>,
) -> Result<(), String> {
    let supported = match app {
        ProjectApp::Explorer | ProjectApp::Powershell => cfg!(windows),
        ProjectApp::Finder | ProjectApp::Ghostty => cfg!(target_os = "macos"),
        ProjectApp::Winc => cfg!(any(windows, target_os = "macos", target_os = "linux")),
    };
    if !supported {
        return Err("this app is not supported on the current platform".to_owned());
    }

    let target = path.unwrap_or(&project.path);
    let target = match &project.connection.kind {
        ConnectionKind::Local if cfg!(windows) => {
            // Explorer and Windows PowerShell need normal drive/UNC paths.
            let target = if let Some(unc) = target.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{unc}")
            } else {
                target.strip_prefix(r"\\?\").unwrap_or(target).to_owned()
            };
            PathBuf::from(target)
        }
        ConnectionKind::Local => PathBuf::from(target),
        ConnectionKind::Wsl { distro } if cfg!(windows) => {
            if distro.is_empty()
                || distro.contains(['/', '\\', ':'])
                || distro.chars().any(char::is_control)
                || !target.starts_with('/')
                || target.contains(['\\', ':'])
                || target.chars().any(char::is_control)
            {
                return Err("invalid WSL directory path".to_owned());
            }
            PathBuf::from(format!(
                r"\\wsl.localhost\{}\{}",
                distro,
                target.trim_start_matches('/').replace('/', "\\")
            ))
        }
        _ => return Err("this app requires a local or Windows WSL project".to_owned()),
    };
    if !target.is_absolute() {
        return Err("app target must be an absolute path".to_owned());
    }
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|error| format!("app target is not accessible: {error}"))?;
    let directory = if metadata.is_file() {
        target
            .parent()
            .ok_or_else(|| "app target has no parent directory".to_owned())?
            .to_path_buf()
    } else if metadata.is_dir() {
        target.clone()
    } else {
        return Err("app target must be a file or directory".to_owned());
    };

    let mut command = match app {
        ProjectApp::Winc => {
            if cfg!(target_os = "macos") {
                let mut command = Command::new("/usr/bin/open");
                command.args(["-na", "winc", "--args", "--"]).arg(&target);
                command
            } else {
                let mut command = Command::new(if cfg!(windows) {
                    winc_windows_executable().await
                } else {
                    PathBuf::from("winc")
                });
                command.arg("--").arg(&target);
                super::hide_console_window(&mut command);
                command
            }
        }
        ProjectApp::Explorer => {
            // Explorer's command-line parser splits unquoted commas in otherwise valid paths.
            return tokio::task::spawn_blocking(move || {
                tauri_plugin_opener::open_path(directory, None::<&str>)
                    .map_err(|error| format!("failed to launch app: {error}"))
            })
            .await
            .map_err(|error| format!("failed to launch app: {error}"))?;
        }
        ProjectApp::Powershell => {
            let windows = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or_else(|| "Windows system directory is unavailable".to_owned())?;
            let mut command =
                Command::new(windows.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
            // Keep paths out of PowerShell source, including quotes and wildcard characters.
            command.env("PILO_OPEN_DIRECTORY", &directory).args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                "Set-Location -LiteralPath $env:PILO_OPEN_DIRECTORY; Remove-Item Env:\\PILO_OPEN_DIRECTORY",
            ]);
            command.current_dir(&directory);
            #[cfg(windows)]
            command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
            command
        }
        ProjectApp::Finder => {
            let mut command = Command::new("/usr/bin/open");
            command.args(["-a", "Finder"]).arg(&directory);
            command
        }
        ProjectApp::Ghostty => {
            let mut command = Command::new("/usr/bin/open");
            // A running Ghostty ignores --args unless open starts a new instance.
            command.args(["-na", "Ghostty", "--args"]).arg(format!(
                "--working-directory={}",
                directory.to_string_lossy()
            ));
            command
        }
    };

    if matches!(app, ProjectApp::Powershell)
        || (matches!(app, ProjectApp::Winc) && !cfg!(target_os = "macos"))
    {
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to launch app: {error}"))?;
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        return Ok(());
    }

    command.kill_on_drop(true);
    let output = timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "timed out while launching app".to_owned())?
        .map_err(|error| format!("failed to launch app: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to launch app: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}
