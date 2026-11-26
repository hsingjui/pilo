use std::{path::PathBuf, time::Duration};

use serde::Deserialize;
use tokio::{process::Command, time::timeout};

use pilo_domain::{ConnectionKind, Project};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectApp {
    Explorer,
    Powershell,
    Finder,
    Ghostty,
    Rex,
    Winc,
}

#[cfg(windows)]
fn windows_executable_exists(path: &std::path::Path) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_file(),
        // Windows Store App Execution Aliases (e.g. WindowsApps\pwsh.exe) can return
        // ERROR_CANT_ACCESS_FILE (1920) from metadata() while still being launchable.
        Err(error) if error.raw_os_error() == Some(1920) => {
            std::fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.is_dir())
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn windows_executable_exists(path: &std::path::Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

async fn powershell_windows_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path).filter(|path| path.is_absolute()) {
            candidates.push(directory.join("pwsh.exe"));
        }
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe"),
        );
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WindowsApps")
                .join("pwsh.exe"),
        );
    }
    if let Some(pwsh) = tokio::task::spawn_blocking(move || {
        candidates
            .into_iter()
            .find(|candidate| windows_executable_exists(candidate))
    })
    .await
    .map_err(|error| format!("failed to locate PowerShell: {error}"))?
    {
        return Ok(pwsh);
    }
    windows_powershell_executable()
}

fn windows_powershell_executable() -> Result<PathBuf, String> {
    let windows = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| "Windows system directory is unavailable".to_owned())?;
    Ok(windows.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
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

async fn rex_windows_executable() -> Result<PathBuf, String> {
    let mut command = Command::new(windows_powershell_executable()?);
    super::hide_console_window(&mut command);
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        r#"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$key = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Superlogical.Rex'
$candidates = @(
    foreach ($hive in 'HKCU', 'HKLM') {
        $location = (Get-ItemProperty -LiteralPath "${hive}:\$key" -ErrorAction SilentlyContinue).InstallLocation
        if ($location -and [IO.Path]::IsPathRooted($location)) { Join-Path $location 'rex.exe' }
    }
    Get-Command rex.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object Source
)
foreach ($path in $candidates) {
    $app = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($app.VersionInfo.ProductName -eq 'Rex' -and $app.VersionInfo.CompanyName -eq 'Superlogical, Inc.') {
        [Console]::Write($app.FullName)
        break
    }
}"#,
    ]);
    let output = run_launcher(command).await?;
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).as_ref());
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("Rex desktop app was not found".to_owned())
    }
}

fn rex_local_command(executable: &std::path::Path) -> Command {
    let mut command = Command::new(executable);
    super::hide_console_window(&mut command);
    command
        .env_remove("REX_SERVER")
        .env_remove("REX_SESSION")
        .env_remove("REX_BLOCK")
        .env_remove("REX_CLIENT")
        .args(["--autostart=false", "--timeout", "2s"]);
    command
}

struct RexLocalTarget {
    session: String,
    client: String,
    pid: Option<u32>,
}

async fn rex_recent_local_target(executable: &std::path::Path) -> Option<RexLocalTarget> {
    // Rex stores its most recently used session for the local host under the empty key.
    let state_path = executable.parent()?.parent()?.join("last_sessions.json");
    let state = tokio::fs::read(state_path).await.ok()?;
    let state: serde_json::Value = serde_json::from_slice(&state).ok()?;
    let session = state[""].as_str()?;
    if !session.starts_with("session:") {
        return None;
    }

    let mut command = rex_local_command(executable);
    command.args(["client", "ls", "--json"]);
    let output = run_launcher(command).await.ok()?;
    let output: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let mut clients = output["clients"].as_array()?.iter().filter(|client| {
        client["info"]["kind"].as_str() == Some("app")
            && client["info"]["platform"].as_str() == Some("windows")
            && client["principal"]["kind"].as_str() == Some("windows_peer")
            && client["connection_state"].as_str() == Some("connected")
            && client["session_ids"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(session)))
    });
    let client = clients.next()?;
    let client_id = client["client_id"].as_str()?;
    if clients.next().is_some() || !client_id.starts_with("client:") {
        return None;
    }
    Some(RexLocalTarget {
        session: session.to_owned(),
        client: client_id.to_owned(),
        pid: client["principal"]["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|&pid| pid != 0),
    })
}

async fn rex_windows_open_tab(
    runtime: &super::Runtime,
    directory: &std::path::Path,
) -> Result<bool, String> {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return Ok(false);
    };
    // Use the CLI bundled with Rex, not the same-named executables on PATH.
    let executable = PathBuf::from(local_app_data).join("Superlogical/Rex/bin/rex-server.exe");
    if !executable.is_absolute() {
        return Ok(false);
    }
    let Some(RexLocalTarget {
        session,
        client,
        pid,
    }) = rex_recent_local_target(&executable).await
    else {
        return Ok(false);
    };

    let mut command = rex_local_command(&executable);
    command
        .args(["window", "new", "--session", &session, "--cwd"])
        .arg(directory);
    // A timeout may occur after Rex created the tab; don't open another session on error.
    run_launcher(command).await?;

    let mut command = rex_local_command(&executable);
    command
        .args(["--client", &client, "do", "session.select"])
        .args(["--session", &session])
        .arg(format!("session_id={session}"));
    if run_launcher(command).await.is_err() {
        log::debug!(target: "project-opener", "Rex created a tab but could not select its session");
    }
    if let (Some(pid), Ok(shell)) = (pid, runtime.shell()) {
        shell.activate_process_window(pid);
    }
    Ok(true)
}

pub(crate) async fn open(
    runtime: &super::Runtime,
    project: &Project,
    app: ProjectApp,
    path: Option<&str>,
) -> Result<(), String> {
    let supported = match app {
        ProjectApp::Explorer | ProjectApp::Powershell => cfg!(windows),
        ProjectApp::Finder | ProjectApp::Ghostty => cfg!(target_os = "macos"),
        ProjectApp::Rex => cfg!(any(windows, target_os = "macos")),
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
        _ if matches!(app, ProjectApp::Rex) => {
            return Err("Rex requires a local project".to_owned());
        }
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
            let runtime = runtime.clone();
            return tokio::task::spawn_blocking(move || {
                runtime
                    .shell()?
                    .open_path(&directory)
                    .map_err(|error| format!("failed to launch app: {error}"))
            })
            .await
            .map_err(|error| format!("failed to launch app: {error}"))?;
        }
        ProjectApp::Powershell => {
            // Start-Process lets Windows give the interactive shell its own console I/O.
            // Pass paths as data, and restore the location after the user's profile runs.
            let mut command = Command::new(windows_powershell_executable()?);
            command
                .env("PILO_OPEN_POWERSHELL", powershell_windows_executable().await?)
                .env("PILO_OPEN_DIRECTORY", &directory)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    r#"$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:PILO_OPEN_POWERSHELL -WorkingDirectory $env:PILO_OPEN_DIRECTORY -ArgumentList '-NoLogo -NoExit -Command "Set-Location -LiteralPath $env:PILO_OPEN_DIRECTORY; Remove-Item Env:\PILO_OPEN_DIRECTORY, Env:\PILO_OPEN_POWERSHELL"'"#,
                ]);
            super::hide_console_window(&mut command);
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
        ProjectApp::Rex => {
            if cfg!(target_os = "macos") {
                const BUNDLE_ID: &str = "com.superlogical.rex";
                let running = Command::new("/usr/bin/pgrep")
                    .args(["-f", r"/Rex( Beta)?\.app/Contents/MacOS/"])
                    .output()
                    .await
                    .is_ok_and(|output| output.status.success());
                if !running {
                    let mut launch = Command::new("/usr/bin/open");
                    launch.args(["-g", "-b", BUNDLE_ID]);
                    run_launcher(launch).await?;
                    // Rex Beta can drop the folder event before its client connects.
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
                let mut command = Command::new("/usr/bin/open");
                command.args(["-b", BUNDLE_ID]).arg(&directory);
                command
            } else {
                if rex_windows_open_tab(runtime, &directory).await? {
                    return Ok(());
                }
                let mut command = Command::new(rex_windows_executable().await?);
                // An existing session can otherwise take precedence over the requested directory.
                command
                    .args(["app", "--new-session", "--cwd"])
                    .arg(&directory);
                super::hide_console_window(&mut command);
                command
            }
        }
    };

    if matches!(app, ProjectApp::Winc | ProjectApp::Rex) && !cfg!(target_os = "macos") {
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to launch app: {error}"))?;
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        return Ok(());
    }

    run_launcher(command).await?;
    Ok(())
}

async fn run_launcher(mut command: Command) -> Result<std::process::Output, String> {
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
    Ok(output)
}

#[cfg(all(test, windows))]
mod tests {
    use super::powershell_windows_executable;

    #[tokio::test]
    async fn powershell_opener_resolves_an_existing_powershell_binary() {
        let executable = powershell_windows_executable().await.unwrap();
        let name = executable
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            name == "pwsh.exe" || name == "powershell.exe",
            "expected pwsh.exe or powershell.exe, got {}",
            executable.display()
        );
    }
}
