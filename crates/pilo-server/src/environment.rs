use std::path::Path;

#[cfg(windows)]
use std::process::Stdio;

use pilo_protocol::EnvironmentInfo;
use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;

use crate::{ServerState, to_value};

#[derive(Deserialize)]
pub(crate) struct ProjectParams {
    pub(crate) project: String,
}

pub(crate) struct ToolchainInfo {
    pub(crate) path: String,
    pub(crate) home: String,
    pub(crate) shell: String,
    pub(crate) pi_executable: String,
    pub(crate) pi_version: String,
    pub(crate) node_executable: String,
    pub(crate) node_version: String,
    pub(crate) git_executable: String,
    pub(crate) git_version: String,
}

pub(crate) async fn environment_inspect(
    state: &ServerState,
    params: ProjectParams,
) -> Result<Value, String> {
    let probe_project = params.project;
    let cwd = tokio::task::spawn_blocking(move || {
        let cwd = std::fs::canonicalize(&probe_project)
            .map_err(|error| format!("project '{probe_project}' is not accessible: {error}"))?;
        if !cwd.is_dir() {
            return Err(format!("project '{probe_project}' is not a directory"));
        }
        Ok::<_, String>(cwd)
    })
    .await
    .map_err(|error| format!("project probe task failed: {error}"))??;
    let toolchain = cached_toolchain(state).await?;
    let git_branch = if toolchain.git_executable.is_empty() {
        None
    } else {
        let value = command_text(
            &toolchain.git_executable,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            Some(&cwd),
            &toolchain.path,
        )
        .await
        .unwrap_or_default();
        (!value.is_empty()).then_some(value)
    };
    to_value(EnvironmentInfo {
        cwd: cwd.to_string_lossy().into_owned(),
        path: toolchain.path.clone(),
        home: toolchain.home.clone(),
        shell: toolchain.shell.clone(),
        pi_executable: toolchain.pi_executable.clone(),
        pi_version: toolchain.pi_version.clone(),
        node_executable: toolchain.node_executable.clone(),
        node_version: toolchain.node_version.clone(),
        git_executable: toolchain.git_executable.clone(),
        git_version: toolchain.git_version.clone(),
        git_branch,
    })
}

pub(crate) fn default_shell() -> String {
    if cfg!(windows) {
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned());
    }
    if let Ok(shell) = std::env::var("SHELL")
        && Path::new(&shell).is_file()
    {
        return shell;
    }
    if let (Ok(home), Ok(passwd)) = (
        std::env::var("HOME"),
        std::fs::read_to_string("/etc/passwd"),
    ) {
        for line in passwd.lines() {
            let fields = line.split(':').collect::<Vec<_>>();
            if fields.len() >= 7 && fields[5] == home && Path::new(fields[6]).is_file() {
                return fields[6].to_owned();
            }
        }
    }
    "/bin/sh".to_owned()
}

async fn login_path(shell: &str) -> Option<String> {
    if cfg!(windows) {
        return std::env::var("PATH").ok();
    }
    const MARKER: &str = "__PILO_LOGIN_PATH__";
    let mut command = Command::new(shell);
    command
        .args(["-ilc", &format!("printf '{MARKER}%s' \"$PATH\"")])
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .rfind(MARKER)
        .map(|index| stdout[index + MARKER.len()..].trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) async fn cached_login_path(state: &ServerState) -> String {
    state
        .login_path
        .get_or_init(|| async {
            let shell = default_shell();
            login_path(&shell)
                .await
                .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
        })
        .await
        .clone()
}

pub(crate) async fn cached_toolchain(state: &ServerState) -> Result<&ToolchainInfo, String> {
    state
        .toolchain
        .get_or_try_init(|| async {
            let shell = default_shell();
            let path = cached_login_path(state).await;
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default();
            let pi_executable = find_command(&path, "pi")
                .ok_or_else(|| "Pi executable 'pi' was not found in PATH".to_owned())?;
            let node_executable = find_command(&path, "node").unwrap_or_default();
            let git_executable = find_command(&path, "git").unwrap_or_default();

            let pi_version_probe = command_text(&pi_executable, &["--version"], None, &path);
            let node_version_probe = async {
                if node_executable.is_empty() {
                    String::new()
                } else {
                    command_text(&node_executable, &["--version"], None, &path)
                        .await
                        .unwrap_or_default()
                }
            };
            let git_version_probe = async {
                if git_executable.is_empty() {
                    String::new()
                } else {
                    command_text(&git_executable, &["--version"], None, &path)
                        .await
                        .unwrap_or_default()
                }
            };
            let (pi_version, node_version, git_version) =
                tokio::join!(pi_version_probe, node_version_probe, git_version_probe);

            Ok(ToolchainInfo {
                path,
                home,
                shell,
                pi_executable,
                pi_version: pi_version?,
                node_executable,
                node_version,
                git_executable,
                git_version,
            })
        })
        .await
}

fn find_command(path: &str, name: &str) -> Option<String> {
    let extensions = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    std::env::split_paths(path).find_map(|dir| {
        if cfg!(windows)
            && let Some(candidate) = extensions.iter().find_map(|extension| {
                let candidate = dir.join(format!("{name}{extension}"));
                candidate.is_file().then_some(candidate)
            })
        {
            return Some(candidate.to_string_lossy().into_owned());
        }
        let candidate = dir.join(name);
        candidate
            .is_file()
            .then(|| candidate.to_string_lossy().into_owned())
    })
}

pub(crate) fn resolve_program(path: &str, program: &str) -> String {
    let candidate = Path::new(program);
    if candidate.is_absolute() || program.contains('/') || program.contains('\\') {
        return program.to_owned();
    }
    find_command(path, program).unwrap_or_else(|| program.to_owned())
}

pub(crate) fn process_command(program: &str, args: &[String], path: &str) -> Command {
    let mut command = Command::new(program);
    command.args(args).env("PATH", path);
    command
}

#[cfg(windows)]
async fn command_text(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    path: &str,
) -> Result<String, String> {
    let program = program.to_owned();
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let cwd = cwd.map(Path::to_path_buf);
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&program);
        command
            .args(&args)
            .env("PATH", path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to run '{program}': {error}"))?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < std::time::Duration::from_secs(8) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "timed out while running '{program} {}'",
                        args.join(" ")
                    ));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("failed to wait for '{program}': {error}"));
                }
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("failed to collect '{program}' output: {error}"))?;
        command_output_text(&output.stdout, &output.stderr, output.status.success())
    })
    .await
    .map_err(|error| format!("tool probe task failed: {error}"))?
}

#[cfg(not(windows))]
async fn command_text(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    path: &str,
) -> Result<String, String> {
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let mut command = process_command(program, &args, path);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(8), command.output())
        .await
        .map_err(|_| format!("timed out while running '{program} {}'", args.join(" ")))?
        .map_err(|error| format!("failed to run '{program}': {error}"))?;
    command_output_text(&output.stdout, &output.stderr, output.status.success())
}

fn command_output_text(stdout: &[u8], stderr: &[u8], success: bool) -> Result<String, String> {
    if !success {
        return Err(String::from_utf8_lossy(stderr).trim().to_owned());
    }
    let text = if stdout.is_empty() { stderr } else { stdout };
    Ok(String::from_utf8_lossy(text).trim().to_owned())
}
