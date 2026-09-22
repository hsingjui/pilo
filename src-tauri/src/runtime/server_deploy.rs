use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Mutex, OnceCell},
};

use crate::domain::{Connection, ConnectionKind};

use super::ssh::{ssh_command, wrap_posix_script};

const SERVER_REMOTE_DIR: &str = ".cache/pilo/server";
/// Pre-fingerprinted-name layout; cleaned up on install.
const LEGACY_SERVER_REMOTE_DIR: &str = ".cache/pilo/server-v3";

pub(super) struct SpawnedServer {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: BufReader<ChildStdout>,
    pub(super) stderr: ChildStderr,
    /// True when the remote binary already matched the current build's
    /// fingerprint, so no upload happened and a protocol mismatch during hello
    /// is worth one forced-redeploy retry.
    pub(super) reused_deployment: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum ServerPlatform {
    Windows,
    Linux,
    Darwin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum ServerArch {
    X86_64,
    Aarch64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct ServerTarget {
    pub(super) platform: ServerPlatform,
    pub(super) arch: ServerArch,
}

impl ServerTarget {
    pub(super) fn resource_name(self) -> Result<&'static str, String> {
        match (self.platform, self.arch) {
            (ServerPlatform::Windows, ServerArch::X86_64) => Ok("pilo-server-windows-x86_64.exe"),
            (ServerPlatform::Linux, ServerArch::X86_64) => Ok("pilo-server-linux-x86_64"),
            (ServerPlatform::Linux, ServerArch::Aarch64) => Ok("pilo-server-linux-aarch64"),
            (ServerPlatform::Darwin, ServerArch::Aarch64) => Ok("pilo-server-darwin-aarch64"),
            (platform, arch) => Err(format!(
                "pilo-server runtime is not bundled for {platform:?} {arch:?}"
            )),
        }
    }

    fn from_uname(os: &str, arch: &str) -> Result<Self, String> {
        let platform = match os.trim().to_ascii_lowercase().as_str() {
            "linux" => ServerPlatform::Linux,
            "darwin" => ServerPlatform::Darwin,
            other => {
                return Err(format!(
                    "remote operating system '{other}' is not supported"
                ));
            }
        };
        let arch = parse_server_arch(arch)?;
        let target = Self { platform, arch };
        target.resource_name()?;
        Ok(target)
    }

    pub(super) fn current() -> Result<Self, String> {
        let platform = if cfg!(target_os = "windows") {
            ServerPlatform::Windows
        } else if cfg!(target_os = "linux") {
            ServerPlatform::Linux
        } else if cfg!(target_os = "macos") {
            ServerPlatform::Darwin
        } else {
            return Err(format!(
                "Pilo server is not bundled for host operating system '{}'",
                std::env::consts::OS
            ));
        };
        let arch = parse_server_arch(std::env::consts::ARCH)?;
        let target = Self { platform, arch };
        target.resource_name()?;
        Ok(target)
    }
}

fn parse_server_arch(arch: &str) -> Result<ServerArch, String> {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Ok(ServerArch::X86_64),
        "aarch64" | "arm64" => Ok(ServerArch::Aarch64),
        other => Err(format!("server architecture '{other}' is not supported")),
    }
}

struct ServerArtifact {
    path: PathBuf,
    fingerprint: String,
    size: u64,
}

static SERVER_ARTIFACTS: OnceCell<Mutex<HashMap<ServerTarget, Arc<ServerArtifact>>>> =
    OnceCell::const_new();

pub(super) async fn spawn_server(
    connection: &Connection,
    force_redeploy: bool,
) -> Result<SpawnedServer, String> {
    match &connection.kind {
        ConnectionKind::Local => {
            // Debug builds embed the current server, so prefer it over the staged
            // resource binary. A stale resource would otherwise shadow the freshly
            // built code and break protocol compatibility in `tauri dev`.
            if cfg!(debug_assertions) {
                let executable = std::env::current_exe()
                    .map_err(|error| format!("failed to locate Pilo executable: {error}"))?;
                let mut command = Command::new(executable);
                command.arg("--pilo-server");
                return spawn_piped_server(command, &connection.name, false);
            }
            let target = ServerTarget::current()?;
            let command = Command::new(server_binary(target)?);
            spawn_piped_server(command, &connection.name, false)
        }
        ConnectionKind::Wsl { .. } => spawn_wsl_server(connection, force_redeploy).await,
        ConnectionKind::Ssh { .. } => spawn_ssh_server(connection, force_redeploy).await,
    }
}

async fn spawn_wsl_server(
    connection: &Connection,
    force_redeploy: bool,
) -> Result<SpawnedServer, String> {
    let ConnectionKind::Wsl { distro } = &connection.kind else {
        return Err("WSL pilo-server spawn requires a WSL connection".to_owned());
    };
    let target = probe_wsl_target(distro).await?;
    let reused_deployment = deploy_server_wsl(distro, target, force_redeploy).await?;
    let mut command = Command::new("wsl.exe");
    command.args([
        "--distribution",
        distro,
        "--exec",
        "/bin/sh",
        "-c",
        &format!("exec \"$HOME/{SERVER_REMOTE_DIR}/pilo-server\""),
    ]);
    spawn_piped_server(command, &connection.name, reused_deployment)
}

async fn spawn_ssh_server(
    connection: &Connection,
    force_redeploy: bool,
) -> Result<SpawnedServer, String> {
    let ConnectionKind::Ssh { target: _ } = &connection.kind else {
        return Err("SSH pilo-server spawn requires an SSH connection".to_owned());
    };
    let server_target = probe_ssh_target(connection).await?;
    let reused_deployment = deploy_server_ssh(connection, server_target, force_redeploy).await?;
    let mut command = ssh_command(connection)?;
    command.arg(wrap_posix_script(&format!(
        "exec \"$HOME/{SERVER_REMOTE_DIR}/pilo-server\""
    )));
    spawn_piped_server(command, &connection.name, reused_deployment)
}

fn spawn_piped_server(
    mut command: Command,
    label: &str,
    reused_deployment: bool,
) -> Result<SpawnedServer, String> {
    super::hide_console_window(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start pilo-server for '{label}': {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pilo-server stdin unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pilo-server stdout unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pilo-server stderr unavailable".to_owned())?;
    Ok(SpawnedServer {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr,
        reused_deployment,
    })
}

pub(super) fn parse_target_probe(output: &[u8], label: &str) -> Result<ServerTarget, String> {
    let output = String::from_utf8_lossy(output);
    let (os, arch) = output.trim().split_once('\t').ok_or_else(|| {
        format!(
            "invalid {label} platform probe response: '{}'",
            output.trim()
        )
    })?;
    ServerTarget::from_uname(os, arch)
}

async fn probe_wsl_target(distro: &str) -> Result<ServerTarget, String> {
    let mut command = Command::new("wsl.exe");
    command.args([
        "--distribution",
        distro,
        "--exec",
        "/bin/sh",
        "-c",
        "printf '%s\\t%s\\n' \"$(uname -s)\" \"$(uname -m)\"",
    ]);
    super::hide_console_window(&mut command);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        command.stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| format!("timed out while probing WSL platform for '{distro}'"))?
    .map_err(|error| format!("failed to probe WSL platform for '{distro}': {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to probe WSL platform for '{distro}': {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let target = parse_target_probe(&output.stdout, "WSL")?;
    if target.platform != ServerPlatform::Linux {
        return Err("WSL target did not report Linux".to_owned());
    }
    Ok(target)
}

async fn probe_ssh_target(connection: &Connection) -> Result<ServerTarget, String> {
    let mut command = ssh_command(connection)?;
    command.arg(wrap_posix_script(
        "printf '%s\\t%s\\n' \"$(uname -s)\" \"$(uname -m)\"",
    ));
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "timed out while probing remote pilo-server platform".to_owned())?
        .map_err(|error| format!("failed to probe remote pilo-server platform: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to probe remote pilo-server platform: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_target_probe(&output.stdout, "remote")
}

async fn deploy_server_wsl(
    distro: &str,
    target: ServerTarget,
    force_redeploy: bool,
) -> Result<bool, String> {
    let artifact = server_artifact(target).await?;
    let source = normalize_windows_path_for_wsl(&artifact.path.to_string_lossy());
    // The deploy script is content-addressed: reuse requires the installed
    // binary to fingerprint exactly like the current build, so the ready check
    // never trusts a stale or corrupted file.
    let install_script = format!(
        "set -e; dst=\"$HOME/{SERVER_REMOTE_DIR}/pilo-server\"; expected=\"{fingerprint}\"; force={force_redeploy}; actual=$(\"$dst\" --fingerprint 2>/dev/null || true); if [ \"$force\" = \"false\" ] && [ \"$actual\" = \"$expected\" ]; then printf 'ready\\n'; exit 0; fi; src=$(wslpath -u \"$1\"); [ -f \"$src\" ] || {{ printf 'source_missing\\t%s\\n' \"$src\" >&2; exit 44; }}; mkdir -p \"$(dirname \"$dst\")\"; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cp -- \"$src\" \"$tmp\"; chmod 700 \"$tmp\"; actual=$(\"$tmp\" --fingerprint 2>/dev/null || true); [ \"$actual\" = \"$expected\" ] || {{ printf 'fingerprint_mismatch\\n' >&2; exit 43; }}; mv -f \"$tmp\" \"$dst\"; trap - EXIT; rm -rf \"$HOME/{LEGACY_SERVER_REMOTE_DIR}\"; printf 'installed\\n'",
        fingerprint = artifact.fingerprint,
    );
    let mut command = Command::new("wsl.exe");
    command.args([
        "--distribution",
        distro,
        "--exec",
        "/bin/sh",
        "-c",
        &install_script,
        "pilo-deploy",
        &source,
    ]);
    super::hide_console_window(&mut command);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        command.stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| format!("timed out while deploying pilo-server to WSL '{distro}'"))?
    .map_err(|error| format!("failed to deploy pilo-server to WSL '{distro}': {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.trim() == "ready" {
        return Ok(true);
    }
    if output.status.success() && stdout.trim() == "installed" {
        return Ok(false);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "failed to deploy pilo-server to WSL '{distro}': {}",
        stderr.trim()
    ))
}

fn normalize_windows_path_for_wsl(value: &str) -> String {
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{value}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
}

async fn server_artifact(target: ServerTarget) -> Result<Arc<ServerArtifact>, String> {
    let artifacts = SERVER_ARTIFACTS
        .get_or_init(|| async { Mutex::new(HashMap::new()) })
        .await;
    if let Some(artifact) = artifacts.lock().await.get(&target).cloned() {
        return Ok(artifact);
    }

    let path = server_binary(target)?;
    let probe_path = path.clone();
    let (fingerprint, size) = tokio::task::spawn_blocking(move || {
        let size = std::fs::metadata(&probe_path)
            .map_err(|error| {
                format!(
                    "failed to inspect pilo-server '{}': {error}",
                    probe_path.display()
                )
            })?
            .len();
        let fingerprint = pilo_server::binary_fingerprint(&probe_path).map_err(|error| {
            format!(
                "failed to fingerprint pilo-server '{}': {error}",
                probe_path.display()
            )
        })?;
        Ok::<_, String>((fingerprint, size))
    })
    .await
    .map_err(|error| format!("pilo-server artifact probe failed: {error}"))??;
    let artifact = Arc::new(ServerArtifact {
        path,
        fingerprint,
        size,
    });
    artifacts.lock().await.insert(target, Arc::clone(&artifact));
    Ok(artifact)
}

async fn deploy_server_ssh(
    connection: &Connection,
    target: ServerTarget,
    force_redeploy: bool,
) -> Result<bool, String> {
    let artifact = server_artifact(target).await?;
    let source = &artifact.path;
    // Content-addressed deploy: reuse requires the installed binary to
    // fingerprint exactly like the current build, so the ready check never
    // trusts a stale or corrupted file.
    let install_script = format!(
        "set -e; dst=\"$HOME/{SERVER_REMOTE_DIR}/pilo-server\"; expected=\"{fingerprint}\"; force={force_redeploy}; actual=$(\"$dst\" --fingerprint 2>/dev/null || true); if [ \"$force\" = \"false\" ] && [ \"$actual\" = \"$expected\" ]; then printf 'ready\\n'; exit 0; fi; mkdir -p \"$(dirname \"$dst\")\"; printf 'upload\\n'; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; chmod 700 \"$tmp\"; actual=$(\"$tmp\" --fingerprint 2>/dev/null || true); [ \"$actual\" = \"$expected\" ] || {{ printf 'fingerprint_mismatch\\n' >&2; exit 43; }}; mv -f \"$tmp\" \"$dst\"; trap - EXIT; rm -rf \"$HOME/{LEGACY_SERVER_REMOTE_DIR}\"; printf 'installed\\n'",
        fingerprint = artifact.fingerprint,
    );
    let mut command = ssh_command(connection)?;
    command.arg(wrap_posix_script(&install_script));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to deploy pilo-server: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pilo-server deploy stdin unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pilo-server deploy stdout unavailable".to_owned())?;
    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pilo-server deploy stderr unavailable".to_owned())?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes).await;
        bytes
    });

    let status_line =
        match tokio::time::timeout(std::time::Duration::from_secs(8), stdout.next_line()).await {
            Ok(line) => line
                .map_err(|error| format!("failed to read pilo-server deploy status: {error}"))?
                .unwrap_or_default(),
            Err(_) => {
                // ssh is still holding the connection; kill it so its stderr closes
                // and we can report the real cause instead of a bare timeout.
                let _ = child.start_kill();
                drop(stdin);
                let stderr = stderr_task.await.unwrap_or_default();
                let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
                return Err(if detail.is_empty() {
                    "timed out while preparing remote pilo-server".to_owned()
                } else {
                    format!("timed out while preparing remote pilo-server: {detail}")
                });
            }
        };
    if status_line == "ready" {
        drop(stdin);
        let status = child.wait().await.map_err(|error| error.to_string())?;
        let stderr = stderr_task.await.unwrap_or_default();
        if status.success() {
            return Ok(true);
        }
        return Err(format!(
            "failed to reuse pilo-server: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if status_line != "upload" {
        drop(stdin);
        let _ = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        return Err(format!(
            "unexpected pilo-server deploy status '{status_line}': {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }

    let mut source_file = tokio::fs::File::open(source)
        .await
        .map_err(|error| format!("failed to open pilo-server '{}': {error}", source.display()))?;
    let uploaded = tokio::io::copy(&mut source_file, &mut stdin)
        .await
        .map_err(|error| format!("failed to upload pilo-server: {error}"))?;
    if uploaded != artifact.size {
        return Err(format!(
            "pilo-server upload was truncated: expected {} bytes, wrote {uploaded}",
            artifact.size
        ));
    }
    drop(stdin);
    let installed_line = stdout
        .next_line()
        .await
        .map_err(|error| format!("failed to read pilo-server install status: {error}"))?
        .unwrap_or_default();
    let status = child.wait().await.map_err(|error| error.to_string())?;
    let stderr = stderr_task.await.unwrap_or_default();
    if !status.success() || installed_line != "installed" {
        return Err(format!(
            "failed to deploy pilo-server ({installed_line}): {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(false)
}

pub(super) fn installed_server_candidates(exe: &Path, resource_name: &str) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else {
        return Vec::new();
    };

    let mut candidates = vec![
        dir.join("runtime").join(resource_name),
        dir.join("../Resources/runtime").join(resource_name),
    ];
    if let Some(exe_name) = exe.file_stem().and_then(|name| name.to_str()) {
        candidates.push(
            dir.join("../lib")
                .join(exe_name)
                .join("runtime")
                .join(resource_name),
        );
    }
    candidates
}

pub(super) fn server_binary(target: ServerTarget) -> Result<PathBuf, String> {
    let resource_name = target.resource_name()?;
    if let Some(path) = std::env::var_os("PILO_SERVER_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }
    if target.platform == ServerPlatform::Linux
        && target.arch == ServerArch::X86_64
        && let Some(path) = std::env::var_os("PILO_SERVER_LINUX_PATH")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    {
        return Ok(path);
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(installed_server_candidates(&exe, resource_name));
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("resources").join(resource_name));

    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
        format!(
            "bundled pilo-server runtime '{resource_name}' is missing; build or stage that target before packaging Pilo"
        )
    })
}
