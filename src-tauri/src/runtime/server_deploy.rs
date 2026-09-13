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

const SERVER_REMOTE_DIR: &str = ".cache/pilo/server-v3";

pub(super) struct SpawnedServer {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: BufReader<ChildStdout>,
    pub(super) stderr: ChildStderr,
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
    pub(super) fn resource_name(self) -> &'static str {
        match (self.platform, self.arch) {
            (ServerPlatform::Windows, ServerArch::X86_64) => "pilo-server-windows-x86_64.exe",
            (ServerPlatform::Windows, ServerArch::Aarch64) => "pilo-server-windows-aarch64.exe",
            (ServerPlatform::Linux, ServerArch::X86_64) => "pilo-server-linux-x86_64",
            (ServerPlatform::Linux, ServerArch::Aarch64) => "pilo-server-linux-aarch64",
            (ServerPlatform::Darwin, ServerArch::X86_64) => "pilo-server-darwin-x86_64",
            (ServerPlatform::Darwin, ServerArch::Aarch64) => "pilo-server-darwin-aarch64",
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
        Ok(Self { platform, arch })
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
        Ok(Self { platform, arch })
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

pub(super) async fn spawn_server(connection: &Connection) -> Result<SpawnedServer, String> {
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
                return spawn_piped_server(command, &connection.name);
            }
            let target = ServerTarget::current()?;
            let command = Command::new(server_binary(target)?);
            spawn_piped_server(command, &connection.name)
        }
        ConnectionKind::Wsl { .. } => spawn_wsl_server(connection).await,
        ConnectionKind::Ssh { .. } => spawn_ssh_server(connection).await,
    }
}

async fn spawn_wsl_server(connection: &Connection) -> Result<SpawnedServer, String> {
    let ConnectionKind::Wsl { distro } = &connection.kind else {
        return Err("WSL pilo-server spawn requires a WSL connection".to_owned());
    };
    let target = probe_wsl_target(distro).await?;
    let remote_path = deploy_server(connection, target).await?;
    let mut command = Command::new("wsl.exe");
    command.args([
        "--distribution",
        distro,
        "--exec",
        "/bin/sh",
        "-c",
        &format!("exec \"$HOME/{remote_path}\""),
    ]);
    spawn_piped_server(command, &connection.name)
}

async fn spawn_ssh_server(connection: &Connection) -> Result<SpawnedServer, String> {
    let ConnectionKind::Ssh { target: _ } = &connection.kind else {
        return Err("SSH pilo-server spawn requires an SSH connection".to_owned());
    };
    let server_target = probe_ssh_target(connection).await?;
    let remote_path = deploy_server(connection, server_target).await?;
    let mut command = ssh_command(connection)?;
    command.arg(wrap_posix_script(&format!("exec \"$HOME/{remote_path}\"")));
    spawn_piped_server(command, &connection.name)
}

fn spawn_piped_server(mut command: Command, label: &str) -> Result<SpawnedServer, String> {
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
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new("wsl.exe")
            .args([
                "--distribution",
                distro,
                "--exec",
                "/bin/sh",
                "-c",
                "printf '%s\\t%s\\n' \"$(uname -s)\" \"$(uname -m)\"",
            ])
            .stdin(Stdio::null())
            .output(),
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

async fn deploy_wsl_server(
    distro: &str,
    source: &Path,
    remote_path: &str,
    fingerprint: &str,
    expected_size: u64,
) -> Result<(), String> {
    let source = normalize_windows_path_for_wsl(&source.to_string_lossy());
    let install_script = format!(
        "set -e; dst=\"$HOME/{remote_path}\"; expected=\"{fingerprint}\"; expected_size={expected_size}; file_size() {{ wc -c < \"$1\" 2>/dev/null | tr -d '[:space:]'; }}; if [ -x \"$dst\" ] && [ \"$(file_size \"$dst\")\" = \"$expected_size\" ]; then printf 'ready\\n'; exit 0; fi; src=$(wslpath -u \"$1\"); [ -f \"$src\" ] || {{ printf 'source_missing\\t%s\\n' \"$src\" >&2; exit 44; }}; [ \"$(file_size \"$src\")\" = \"$expected_size\" ] || {{ printf 'source_size_mismatch\\n' >&2; exit 45; }}; mkdir -p \"$(dirname \"$dst\")\"; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cp -- \"$src\" \"$tmp\"; [ \"$(file_size \"$tmp\")\" = \"$expected_size\" ] || {{ printf 'copy_size_mismatch\\n' >&2; exit 46; }}; chmod 700 \"$tmp\"; mv -f \"$tmp\" \"$dst\"; trap - EXIT; actual=$(\"$dst\" --fingerprint 2>/dev/null || true); [ \"$actual\" = \"$expected\" ] || {{ rm -f \"$dst\"; printf 'fingerprint_mismatch\\n' >&2; exit 43; }}; printf 'installed\\n'"
    );
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        Command::new("wsl.exe")
            .args([
                "--distribution",
                distro,
                "--exec",
                "/bin/sh",
                "-c",
                &install_script,
                "pilo-deploy",
                &source,
            ])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| format!("timed out while deploying pilo-server to WSL '{distro}'"))?
    .map_err(|error| format!("failed to deploy pilo-server to WSL '{distro}': {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && matches!(stdout.trim(), "ready" | "installed") {
        return Ok(());
    }
    if let Some(arch) = stdout
        .lines()
        .find_map(|line| line.strip_prefix("unsupported\t"))
    {
        return Err(format!(
            "WSL architecture '{arch}' is not supported by the bundled Linux pilo-server"
        ));
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

async fn deploy_server(connection: &Connection, target: ServerTarget) -> Result<String, String> {
    let artifact = server_artifact(target).await?;
    let source = &artifact.path;
    let fingerprint = &artifact.fingerprint;
    let remote_path = format!("{SERVER_REMOTE_DIR}/pilo-server-{fingerprint}");
    if let ConnectionKind::Wsl { distro } = &connection.kind {
        deploy_wsl_server(distro, source, &remote_path, fingerprint, artifact.size).await?;
        return Ok(remote_path);
    }
    let install_script = format!(
        "set -e; dst=\"$HOME/{remote_path}\"; expected=\"{fingerprint}\"; expected_size={}; file_size() {{ wc -c < \"$1\" 2>/dev/null | tr -d '[:space:]'; }}; if [ -x \"$dst\" ] && [ \"$(file_size \"$dst\")\" = \"$expected_size\" ]; then printf 'ready\\n'; exit 0; fi; rm -f \"$dst\"; mkdir -p \"$(dirname \"$dst\")\"; printf 'upload\\n'; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; [ \"$(file_size \"$tmp\")\" = \"$expected_size\" ] || {{ printf 'upload_size_mismatch\\n'; exit 45; }}; chmod 700 \"$tmp\"; mv -f \"$tmp\" \"$dst\"; trap - EXIT; actual=$(\"$dst\" --fingerprint 2>/dev/null || true); [ \"$actual\" = \"$expected\" ] || {{ rm -f \"$dst\"; printf 'fingerprint_mismatch\\n'; exit 43; }}; printf 'installed\\n'",
        artifact.size,
    );
    let mut command = match &connection.kind {
        ConnectionKind::Wsl { .. } => unreachable!("WSL deployment is handled before upload"),
        ConnectionKind::Ssh { .. } => {
            let mut command = ssh_command(connection)?;
            command.arg(wrap_posix_script(&install_script));
            command
        }
        ConnectionKind::Local => return Ok(String::new()),
    };
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

    let status_line = tokio::time::timeout(std::time::Duration::from_secs(8), stdout.next_line())
        .await
        .map_err(|_| "timed out while preparing remote pilo-server".to_owned())?
        .map_err(|error| format!("failed to read pilo-server deploy status: {error}"))?
        .unwrap_or_default();
    if status_line == "ready" {
        drop(stdin);
        let status = child.wait().await.map_err(|error| error.to_string())?;
        let stderr = stderr_task.await.unwrap_or_default();
        if status.success() {
            return Ok(remote_path);
        }
        return Err(format!(
            "failed to reuse pilo-server: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if let Some(arch) = status_line.strip_prefix("unsupported\t") {
        drop(stdin);
        let _ = child.wait().await;
        let _ = stderr_task.await;
        return Err(format!(
            "remote architecture '{arch}' is not supported by the bundled Linux pilo-server"
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
    Ok(remote_path)
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
    let resource_name = target.resource_name();
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
