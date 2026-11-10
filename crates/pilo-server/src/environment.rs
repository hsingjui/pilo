use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::process::Stdio;

use pilo_protocol::{EnvironmentInfo, PiExecutableInfo};
use serde::Deserialize;
use serde_json::Value;
use tokio::{process::Command, sync::Mutex};

use crate::{ServerState, to_value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectParams {
    pub(crate) project: String,
    #[serde(default)]
    pub(crate) pi_executable: Option<String>,
    /// Pi 运行位置："workspace" 在连接环境内，"local" 在 Pilo 本机。
    /// local 时无需（也不应）探测连接环境中的 Pi。
    #[serde(default)]
    pub(crate) pi_runtime: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct PiProbeParams {
    #[serde(default)]
    pub(crate) executable: Option<String>,
}

pub(crate) struct ToolchainInfo {
    pub(crate) path: String,
    pub(crate) home: String,
    pub(crate) shell: String,
    pub(crate) node_executable: String,
    pub(crate) node_version: String,
    pub(crate) git_executable: String,
    pub(crate) git_version: String,
}

fn resolve_project_path(project: &str) -> Result<PathBuf, String> {
    let project = project
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .or_else(|| {
            project
                .strip_prefix('\'')
                .and_then(|path| path.strip_suffix('\''))
        })
        .unwrap_or(project);
    if project.is_empty() {
        return Err("project path cannot be empty".to_owned());
    }

    let home_relative = if project == "~" {
        Some("")
    } else {
        project.strip_prefix("~/").or_else(|| {
            if cfg!(windows) {
                project.strip_prefix("~\\")
            } else {
                None
            }
        })
    };
    if let Some(relative) = home_relative {
        let home = std::env::home_dir()
            .ok_or_else(|| "project home directory is not available".to_owned())?;
        return Ok(home.join(relative.trim_start_matches(std::path::is_separator)));
    }
    Ok(PathBuf::from(project))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DefaultWorkspaceParams {
    key: String,
    #[serde(default)]
    development: bool,
}

pub(crate) async fn ensure_default_workspace(
    params: DefaultWorkspaceParams,
) -> Result<Value, String> {
    if params.key.is_empty()
        || params.key.len() > 64
        || !params
            .key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err("invalid default workspace key".to_owned());
    }
    tokio::task::spawn_blocking(move || {
        let home = std::env::home_dir()
            .filter(|path| path.is_absolute())
            .ok_or_else(|| "default workspace home directory is not available".to_owned())?;
        let root = if params.development {
            ".pilo-dev"
        } else {
            ".pilo"
        };
        let path = home.join(root).join("workspaces").join(params.key);
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("failed to create default workspace: {error}"))?;
        let path = std::fs::canonicalize(&path)
            .map_err(|error| format!("failed to resolve default workspace: {error}"))?;
        crate::to_value(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("default workspace setup task failed: {error}"))?
}

pub(crate) async fn environment_inspect(
    state: &ServerState,
    params: ProjectParams,
) -> Result<Value, String> {
    let probe_project = params.project;
    let cwd = tokio::task::spawn_blocking(move || {
        let project_path = resolve_project_path(&probe_project)?;
        let cwd = std::fs::canonicalize(project_path)
            .map_err(|error| format!("project '{probe_project}' is not accessible: {error}"))?;
        if !cwd.is_dir() {
            return Err(format!("project '{probe_project}' is not a directory"));
        }
        Ok::<_, String>(cwd)
    })
    .await
    .map_err(|error| format!("project probe task failed: {error}"))??;
    let toolchain = cached_toolchain(state).await?;
    let pi_probe = async {
        if params.pi_runtime.as_deref() == Some("local") {
            Ok(PiExecutableInfo {
                executable: String::new(),
                version: String::new(),
            })
        } else {
            probe_pi_executable(state, params.pi_executable.as_deref()).await
        }
    };
    let git_probe = async {
        if toolchain.git_executable.is_empty() {
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
        }
    };
    let (pi, git_branch) = tokio::join!(pi_probe, git_probe);
    let pi = pi?;
    to_value(EnvironmentInfo {
        cwd: cwd.to_string_lossy().into_owned(),
        path: toolchain.path.clone(),
        home: toolchain.home.clone(),
        shell: toolchain.shell.clone(),
        pi_executable: pi.executable,
        pi_version: pi.version,
        node_executable: toolchain.node_executable.clone(),
        node_version: toolchain.node_version.clone(),
        git_executable: toolchain.git_executable.clone(),
        git_version: toolchain.git_version.clone(),
        git_branch,
    })
}

pub(crate) async fn environment_pi_probe(
    state: &ServerState,
    params: PiProbeParams,
) -> Result<Value, String> {
    to_value(probe_pi_executable(state, params.executable.as_deref()).await?)
}

async fn probe_pi_executable(
    state: &ServerState,
    requested: Option<&str>,
) -> Result<PiExecutableInfo, String> {
    let (executable, path) = resolve_pi_executable(state, requested).await?;
    let version = command_text(&executable, &["--version"], None, &path).await?;
    Ok(PiExecutableInfo {
        executable,
        version,
    })
}

pub(crate) async fn resolve_pi_executable(
    state: &ServerState,
    requested: Option<&str>,
) -> Result<(String, String), String> {
    let mut path = tool_search_path(&cached_login_path(state).await);
    if let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        let executable = resolve_program(&path, requested);
        if let Some(parent) = Path::new(&executable)
            .parent()
            .filter(|dir| dir.is_absolute())
        {
            path = append_search_paths(&path, [parent.to_path_buf()]);
        }
        return Ok((executable, path));
    }
    if let Some(executable) = find_command(&path, "pi") {
        return Ok((executable, path));
    }

    // A retry after installation must not reuse a cached "not found" result.
    if let Some(current) = login_path(&default_shell()).await {
        path = append_search_paths(&current, std::env::split_paths(&path));
    }
    path = tool_search_path(&path);
    if find_command(&path, "pi").is_none() {
        let (npm, pnpm, bun) = tokio::join!(
            global_bin_dir(&path, "npm", &["prefix", "-g"]),
            global_bin_dir(&path, "pnpm", &["bin", "-g"]),
            global_bin_dir(&path, "bun", &["pm", "bin", "-g"]),
        );
        path = append_search_paths(&path, [npm, pnpm, bun].into_iter().flatten());
    }
    let executable = find_command(&path, "pi")
        .ok_or_else(|| "Pi executable 'pi' was not found in PATH or global install directories; configure the Pi executable path explicitly".to_owned())?;
    // Saving the detected executable must retain its refreshed runtime PATH.
    if let Some(cached) = state.login_path.get() {
        let mut cached = cached.lock().await;
        path = append_search_paths(&path, std::env::split_paths(cached.as_str()));
        *cached = path.clone();
    }
    Ok((executable, path))
}

async fn global_bin_dir(path: &str, name: &str, args: &[&str]) -> Option<PathBuf> {
    let program = find_command(path, name)?;
    let home = std::env::home_dir();
    let output = command_text(&program, args, home.as_deref(), path)
        .await
        .ok()?;
    let dir = PathBuf::from(output.trim());
    if !dir.is_absolute() {
        return None;
    }
    Some(if name == "npm" && !cfg!(windows) {
        dir.join("bin")
    } else {
        dir
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
    const MARKER: &str = "__PILO_LOGIN_PATH__";
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inherited = $env:PATH
foreach ($scope in @('Machine', 'User')) {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($key in $vars.Keys) {
        if ($key -ne 'Path') {
            [Environment]::SetEnvironmentVariable($key, [Environment]::ExpandEnvironmentVariables([string]$vars[$key]), 'Process')
        }
    }
}
$p = @($inherited, [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'))
[Console]::Write('__PILO_LOGIN_PATH__' + ($p -join ';'))",
        ]);
        command
    } else {
        let mut command = Command::new(shell);
        command.args(["-ilc", &format!("printf '{MARKER}%s' \"$PATH\"")]);
        command
    };
    command
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
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
            let inherited = std::env::var("PATH").unwrap_or_default();
            let login = login_path(&shell).await.unwrap_or_default();
            Mutex::new(tool_search_path(&append_search_paths(
                &login,
                std::env::split_paths(&inherited),
            )))
        })
        .await
        .lock()
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
            let node_executable = find_command(&path, "node").unwrap_or_default();
            let git_executable = find_command(&path, "git").unwrap_or_default();

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
            let (node_version, git_version) = tokio::join!(node_version_probe, git_version_probe);

            Ok(ToolchainInfo {
                path,
                home,
                shell,
                node_executable,
                node_version,
                git_executable,
                git_version,
            })
        })
        .await
}

fn append_search_paths(path: &str, extra: impl IntoIterator<Item = PathBuf>) -> String {
    let mut dirs = Vec::<PathBuf>::new();
    for dir in std::env::split_paths(path).chain(extra) {
        if dir.as_os_str().is_empty()
            || dirs.iter().any(|existing| {
                if cfg!(windows) {
                    existing
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&dir.to_string_lossy())
                } else {
                    existing == &dir
                }
            })
        {
            continue;
        }
        dirs.push(dir);
    }
    std::env::join_paths(dirs)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned())
}

fn tool_search_path(path: &str) -> String {
    let mut dirs = Vec::new();
    for key in ["PNPM_HOME", "NVM_BIN", "NVM_SYMLINK", "PI_MANAGED_BIN_DIR"] {
        if let Some(dir) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            let dir = PathBuf::from(dir);
            if key == "PNPM_HOME" {
                dirs.push(dir.join("bin"));
            }
            dirs.push(dir);
        }
    }
    for key in ["BUN_INSTALL", "VOLTA_HOME", "PI_CODING_AGENT_DIR"] {
        if let Some(dir) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            dirs.push(PathBuf::from(dir).join("bin"));
        }
    }
    #[cfg(windows)]
    if let Some(dir) = std::env::var_os("MISE_DATA_DIR").filter(|value| !value.is_empty()) {
        dirs.push(PathBuf::from(dir).join("shims"));
    }
    for key in [
        "npm_config_prefix",
        "NPM_CONFIG_PREFIX",
        "PI_NPM_INSTALL_PREFIX",
    ] {
        if let Some(dir) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            let dir = PathBuf::from(dir);
            dirs.push(if cfg!(windows) { dir } else { dir.join("bin") });
        }
    }
    if let Some(root) = std::env::var_os("PI_MANAGED_INSTALL_ROOT")
        && let Some(parent) = Path::new(&root).parent()
    {
        dirs.push(parent.join("bin"));
    }
    if let Some(home) = std::env::home_dir() {
        for dir in [
            ".pi/agent/bin",
            ".local/bin",
            "bin",
            ".bin",
            "local/bin",
            ".bun/bin",
            ".volta/bin",
        ] {
            dirs.push(home.join(dir));
        }
        if cfg!(windows) {
            for (key, suffix) in [
                ("APPDATA", "npm"),
                ("LOCALAPPDATA", "pnpm"),
                ("LOCALAPPDATA", "pnpm/bin"),
                ("LOCALAPPDATA", "pi-node/current"),
                ("ProgramFiles", "nodejs"),
                ("LOCALAPPDATA", "mise/shims"),
            ] {
                if let Some(base) = std::env::var_os(key) {
                    dirs.push(PathBuf::from(base).join(suffix));
                }
            }
        } else {
            let data = std::env::var_os("XDG_DATA_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share"));
            dirs.extend([
                data.join("pnpm"),
                data.join("pnpm/bin"),
                data.join("pi-node/current/bin"),
            ]);
            dirs.push(home.join(".npm-global/bin"));
            #[cfg(target_os = "macos")]
            dirs.extend([
                home.join("Library/pnpm"),
                home.join("Library/pnpm/bin"),
                PathBuf::from("/opt/homebrew/bin"),
            ]);
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
    }
    // Keep absent directories too: they may be created by a later install.
    append_search_paths(path, dirs.into_iter().filter(|dir| dir.is_absolute()))
}

fn find_command(path: &str, name: &str) -> Option<String> {
    let has_extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "exe" | "com" | "cmd" | "bat"
            )
        });
    let extensions = if cfg!(windows) && !has_extension {
        let mut extensions = std::env::var("PATHEXT")
            .unwrap_or_default()
            .split(';')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), ".exe" | ".com" | ".cmd" | ".bat"))
            .collect::<Vec<_>>();
        for extension in [".com", ".exe", ".bat", ".cmd"] {
            if !extensions.iter().any(|value| value == extension) {
                extensions.push(extension.to_owned());
            }
        }
        extensions
    } else {
        vec![String::new()]
    };
    std::env::split_paths(path).find_map(|dir| {
        extensions.iter().find_map(|extension| {
            let candidate = dir.join(format!("{name}{extension}"));
            let metadata = std::fs::metadata(&candidate).ok()?;
            if !metadata.is_file() {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    return None;
                }
            }
            Some(candidate.to_string_lossy().into_owned())
        })
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
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
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
        use std::os::windows::process::CommandExt;

        let invocation = std::iter::once(&program)
            .chain(args.iter())
            .map(|value| format!("'{}'", value.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(" ");
        // Set the child console code page too, so cmd shims emit UTF-8 diagnostics.
        let script = format!(
            "$ErrorActionPreference = 'Stop'; \
             [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             $OutputEncoding = [Console]::OutputEncoding; \
             & {invocation}; exit $LASTEXITCODE"
        );
        let mut command = std::process::Command::new("powershell.exe");
        command.creation_flags(0x0800_0000);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .env("PATH", path)
            .env("COREPACK_ENABLE_NETWORK", "0")
            .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
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
    command
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
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
