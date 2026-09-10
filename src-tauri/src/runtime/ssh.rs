use std::time::Duration;

use serde::Serialize;
use thiserror::Error;
use tokio::{process::Command, time::timeout};

use crate::domain::{SshConnection, SshEnvironmentInfo, SshTarget};

use super::process::ProcessSpec;

const SSH_PROGRAM: &str = "ssh";
const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 10;
const SSH_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_BEGIN: &str = "__PILO_SSH_ENV_BEGIN__";
const PROBE_END: &str = "__PILO_SSH_ENV_END__";
const WORKSPACE_ERROR_MARKER: &str = "__PILO_SSH_WORKSPACE_INVALID__";
pub(crate) const RPC_READY_MARKER: &str = "__PILO_SSH_RPC_READY_V1__";

const ENVIRONMENT_PROBE_SCRIPT: &str = r#"
pi_path="$(command -v pi 2>/dev/null || true)"
node_path="$(command -v node 2>/dev/null || true)"
git_path="$(command -v git 2>/dev/null || true)"

printf '__PILO_SSH_ENV_BEGIN__\n'
printf 'cwd=%s\n' "$(pwd -P)"
printf 'pi_executable=%s\n' "$pi_path"
if [ -n "$pi_path" ]; then
    printf 'pi_version=%s\n' "$("$pi_path" --version 2>&1)"
else
    printf 'pi_version=\n'
fi
printf 'node_executable=%s\n' "$node_path"
if [ -n "$node_path" ]; then
    printf 'node_version=%s\n' "$("$node_path" --version 2>&1)"
else
    printf 'node_version=\n'
fi
printf 'git_executable=%s\n' "$git_path"
if [ -n "$git_path" ]; then
    printf 'git_version=%s\n' "$("$git_path" --version 2>&1)"
    printf 'git_branch=%s\n' "$("$git_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
else
    printf 'git_version=\n'
    printf 'git_branch=\n'
fi
printf '__PILO_SSH_ENV_END__\n'
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SshConnectionErrorCode {
    SshUnavailable,
    InvalidHost,
    InvalidWorkspace,
    ConnectionFailed,
    EnvironmentProbeFailed,
    PiNotFound,
    NodeNotFound,
    GitNotFound,
    PiSpawnFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionError {
    pub code: SshConnectionErrorCode,
    pub message: String,
}

impl SshConnectionError {
    fn new(code: SshConnectionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn pi_spawn(error: impl std::fmt::Display) -> Self {
        Self::new(
            SshConnectionErrorCode::PiSpawnFailed,
            format!("failed to start SSH Pi RPC: {error}"),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionProbe {
    pub connection: SshConnection,
    pub environment: SshEnvironmentInfo,
}

pub(crate) struct SshLaunchPlan {
    pub connection: SshConnection,
    pub environment: SshEnvironmentInfo,
    pub process: ProcessSpec,
}

pub async fn probe_ssh_connection(
    target: SshTarget,
    workspace: String,
) -> Result<SshConnectionProbe, SshConnectionError> {
    let (connection, environment, _) = inspect_ssh_connection(target, workspace).await?;
    Ok(SshConnectionProbe {
        connection,
        environment,
    })
}

pub(crate) async fn prepare_ssh_launch(
    target: SshTarget,
    workspace: String,
) -> Result<SshLaunchPlan, SshConnectionError> {
    let (connection, environment, path) = inspect_ssh_connection(target, workspace).await?;
    let process = ssh_process_spec(
        &connection.target,
        &environment.cwd,
        &path,
        &environment.pi_executable,
    );

    Ok(SshLaunchPlan {
        connection,
        environment,
        process,
    })
}

async fn inspect_ssh_connection(
    target: SshTarget,
    workspace: String,
) -> Result<(SshConnection, SshEnvironmentInfo, String), SshConnectionError> {
    let target = normalize_target(target)?;
    let target_label = target_label(&target);
    let workspace = normalize_workspace(&workspace)?;
    let login_environment = read_login_environment(&target).await?;
    let path = environment_value(&login_environment, "PATH")
        .ok_or_else(|| {
            SshConnectionError::new(
                SshConnectionErrorCode::EnvironmentProbeFailed,
                format!("SSH target '{target_label}' login environment did not expose PATH"),
            )
        })?
        .to_owned();

    let environment = probe_environment_with_path(&target, &workspace, &path).await?;
    validate_environment(&target_label, &environment)?;

    Ok((SshConnection::from_target(target), environment, path))
}

fn normalize_target(target: SshTarget) -> Result<SshTarget, SshConnectionError> {
    match target {
        SshTarget::ConfigHost { host } => Ok(SshTarget::ConfigHost {
            host: normalize_destination(&host, "SSH config host")?,
        }),
        SshTarget::Direct {
            hostname,
            port,
            user,
            identity_file,
        } => {
            if port == Some(0) {
                return Err(SshConnectionError::new(
                    SshConnectionErrorCode::InvalidHost,
                    "SSH port must be between 1 and 65535",
                ));
            }

            let user = user
                .map(|user| normalize_destination(&user, "SSH user"))
                .transpose()?;
            let identity_file = identity_file
                .map(|path| normalize_identity_file(&path))
                .transpose()?;

            Ok(SshTarget::Direct {
                hostname: normalize_destination(&hostname, "SSH hostname")?,
                port,
                user,
                identity_file,
            })
        }
    }
}

fn normalize_destination(value: &str, label: &str) -> Result<String, SshConnectionError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidHost,
            format!("{label} cannot be empty"),
        ));
    }
    if value.starts_with('-') || value.chars().any(char::is_whitespace) {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidHost,
            format!("{label} must be a single value and cannot start with '-'"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidHost,
            format!("{label} cannot contain control characters"),
        ));
    }
    Ok(value.to_owned())
}

fn normalize_identity_file(path: &str) -> Result<String, SshConnectionError> {
    let path = path.trim();
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidHost,
            "SSH identity file cannot be empty or contain control characters",
        ));
    }
    Ok(path.to_owned())
}

fn target_label(target: &SshTarget) -> String {
    match target {
        SshTarget::ConfigHost { host } => host.clone(),
        SshTarget::Direct {
            hostname,
            port,
            user,
            ..
        } => {
            let destination = match user.as_deref() {
                Some(user) => format!("{user}@{hostname}"),
                None => hostname.clone(),
            };
            match port {
                Some(port) => format!("{destination}:{port}"),
                None => destination,
            }
        }
    }
}

fn normalize_workspace(workspace: &str) -> Result<String, SshConnectionError> {
    let workspace = workspace.trim();
    if workspace.is_empty() {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidWorkspace,
            "SSH workspace path cannot be empty",
        ));
    }
    if !workspace.starts_with('/') && workspace != "~" && !workspace.starts_with("~/") {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidWorkspace,
            format!("SSH workspace '{workspace}' must be a POSIX absolute path or '~' path"),
        ));
    }
    if workspace.contains(['\n', '\r', '\0']) {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::InvalidWorkspace,
            "SSH workspace path cannot contain NUL or line-break characters",
        ));
    }
    Ok(workspace.to_owned())
}

async fn read_login_environment(target: &SshTarget) -> Result<Vec<u8>, SshConnectionError> {
    let script = r#"shell="${SHELL:-/bin/sh}"
exec "$shell" -l -i -c '/usr/bin/env -0'"#;
    let remote_command = wrap_posix_script(script);
    let output = run_ssh_probe(target, &remote_command, "SSH login environment probe").await?;
    Ok(output.stdout)
}

async fn probe_environment_with_path(
    target: &SshTarget,
    workspace: &str,
    path: &str,
) -> Result<SshEnvironmentInfo, SshConnectionError> {
    let label = target_label(target);
    let script = format!(
        "if ! {}; then printf '%s\\n' {} >&2; exit 72; fi\nexec /usr/bin/env PATH={} /bin/sh -c {}",
        workspace_cd_command(workspace),
        shell_quote(WORKSPACE_ERROR_MARKER),
        shell_quote(path),
        shell_quote(ENVIRONMENT_PROBE_SCRIPT),
    );
    let remote_command = wrap_posix_script(&script);
    let output = run_ssh_probe(target, &remote_command, "SSH environment probe")
        .await
        .map_err(|error| {
            if error.message.contains(WORKSPACE_ERROR_MARKER) {
                SshConnectionError::new(
                    SshConnectionErrorCode::InvalidWorkspace,
                    format!("SSH workspace '{workspace}' is not accessible on '{label}'"),
                )
            } else {
                error
            }
        })?;

    parse_environment_probe(&output.stdout)
}

async fn run_ssh_probe(
    target: &SshTarget,
    remote_command: &str,
    label: &str,
) -> Result<std::process::Output, SshConnectionError> {
    let target_label = target_label(target);
    let mut args = ssh_base_args(target);
    args.push(remote_command.to_owned());

    let output = timeout(
        SSH_PROBE_TIMEOUT,
        Command::new(SSH_PROGRAM).args(&args).output(),
    )
    .await
    .map_err(|_| {
        SshConnectionError::new(
            SshConnectionErrorCode::ConnectionFailed,
            format!("timed out while running {label} for '{target_label}'"),
        )
    })?
    .map_err(|error| {
        SshConnectionError::new(
            SshConnectionErrorCode::SshUnavailable,
            format!("failed to run system OpenSSH '{SSH_PROGRAM}': {error}"),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::ConnectionFailed,
            format_command_failure(label, output.status.to_string(), &stderr),
        ));
    }

    Ok(output)
}

fn validate_environment(
    target_label: &str,
    environment: &SshEnvironmentInfo,
) -> Result<(), SshConnectionError> {
    if environment.pi_executable.is_empty() {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::PiNotFound,
            format!("Pi executable 'pi' was not found on SSH target '{target_label}' login PATH"),
        ));
    }
    if environment.node_executable.is_empty() {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::NodeNotFound,
            format!(
                "Node executable 'node' was not found on SSH target '{target_label}' login PATH"
            ),
        ));
    }
    if environment.git_executable.is_empty() {
        return Err(SshConnectionError::new(
            SshConnectionErrorCode::GitNotFound,
            format!("Git executable 'git' was not found on SSH target '{target_label}' login PATH"),
        ));
    }

    for (tool, version) in [
        ("Pi", environment.pi_version.as_str()),
        ("Node", environment.node_version.as_str()),
        ("Git", environment.git_version.as_str()),
    ] {
        if version.is_empty() {
            return Err(SshConnectionError::new(
                SshConnectionErrorCode::EnvironmentProbeFailed,
                format!(
                    "{tool} version probe returned no version text on SSH target '{target_label}'"
                ),
            ));
        }
    }

    Ok(())
}

fn ssh_process_spec(target: &SshTarget, cwd: &str, path: &str, pi_executable: &str) -> ProcessSpec {
    let script = format!(
        "if ! {}; then printf '%s\\n' {} >&2; exit 72; fi\nprintf '%s\\n' {}\nexec /usr/bin/env PATH={} {} --mode rpc",
        workspace_cd_command(cwd),
        shell_quote(WORKSPACE_ERROR_MARKER),
        shell_quote(RPC_READY_MARKER),
        shell_quote(path),
        shell_quote(pi_executable),
    );
    let mut args = ssh_base_args(target);
    args.push(wrap_posix_script(&script));

    ProcessSpec {
        program: SSH_PROGRAM.to_owned(),
        args,
        cwd: None,
        env: Default::default(),
        stdout_ready_marker: Some(RPC_READY_MARKER.to_owned()),
    }
}

fn ssh_base_args(target: &SshTarget) -> Vec<String> {
    let mut args = vec![
        "-T".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        "-o".to_owned(),
        "RemoteCommand=none".to_owned(),
    ];

    match target {
        SshTarget::ConfigHost { host } => args.push(host.clone()),
        SshTarget::Direct {
            hostname,
            port,
            user,
            identity_file,
        } => {
            if let Some(port) = port {
                args.extend(["-p".to_owned(), port.to_string()]);
            }
            if let Some(user) = user {
                args.extend(["-l".to_owned(), user.clone()]);
            }
            if let Some(identity_file) = identity_file {
                args.extend(["-i".to_owned(), identity_file.clone()]);
            }
            args.push(hostname.clone());
        }
    }

    args
}

fn workspace_cd_command(workspace: &str) -> String {
    if workspace == "~" {
        return "cd \"$HOME\"".to_owned();
    }
    if let Some(relative) = workspace.strip_prefix("~/") {
        return format!("cd \"$HOME\"/{}", shell_quote(relative));
    }
    format!("cd {}", shell_quote(workspace))
}

fn wrap_posix_script(script: &str) -> String {
    format!("/bin/sh -c {}", shell_quote(script))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn environment_value<'a>(bytes: &'a [u8], key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    bytes.split(|byte| *byte == 0).find_map(|entry| {
        let entry = std::str::from_utf8(entry).ok()?;
        entry
            .lines()
            .find_map(|line| line.strip_prefix(&prefix).filter(|value| !value.is_empty()))
    })
}

fn parse_environment_probe(bytes: &[u8]) -> Result<SshEnvironmentInfo, SshConnectionError> {
    let text = String::from_utf8_lossy(bytes);
    let body = text
        .split_once(PROBE_BEGIN)
        .and_then(|(_, tail)| tail.split_once(PROBE_END).map(|(body, _)| body))
        .ok_or_else(|| {
            SshConnectionError::new(
                SshConnectionErrorCode::EnvironmentProbeFailed,
                "SSH environment probe returned an unexpected payload",
            )
        })?;

    let value = |key: &str| -> String {
        body.lines()
            .find_map(|line| line.strip_prefix(&format!("{key}=")))
            .unwrap_or_default()
            .trim()
            .to_owned()
    };

    let git_branch = value("git_branch");
    Ok(SshEnvironmentInfo {
        cwd: value("cwd"),
        git_branch: (!git_branch.is_empty()).then_some(git_branch),
        pi_executable: value("pi_executable"),
        pi_version: value("pi_version"),
        node_executable: value("node_executable"),
        node_version: value("node_version"),
        git_executable: value("git_executable"),
        git_version: value("git_version"),
    })
}

fn format_command_failure(label: &str, status: String, stderr: &str) -> String {
    if stderr.trim().is_empty() {
        format!("{label} exited with {status}")
    } else {
        format!("{label} exited with {status}: {}", stderr.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ssh_config_alias_and_direct_target() {
        assert_eq!(
            normalize_target(SshTarget::ConfigHost {
                host: "devbox".to_owned(),
            })
            .unwrap(),
            SshTarget::ConfigHost {
                host: "devbox".to_owned(),
            }
        );

        assert_eq!(
            normalize_target(SshTarget::Direct {
                hostname: "192.0.2.10".to_owned(),
                port: Some(2222),
                user: Some("deploy".to_owned()),
                identity_file: Some("~/.ssh/deploy".to_owned()),
            })
            .unwrap(),
            SshTarget::Direct {
                hostname: "192.0.2.10".to_owned(),
                port: Some(2222),
                user: Some("deploy".to_owned()),
                identity_file: Some("~/.ssh/deploy".to_owned()),
            }
        );
    }

    #[test]
    fn rejects_option_like_or_whitespace_host() {
        for host in ["", "-Fother-config", "dev box"] {
            let error = normalize_target(SshTarget::ConfigHost {
                host: host.to_owned(),
            })
            .unwrap_err();
            assert_eq!(error.code, SshConnectionErrorCode::InvalidHost);
        }
    }

    #[test]
    fn rejects_invalid_direct_target_values() {
        let error = normalize_target(SshTarget::Direct {
            hostname: "devbox".to_owned(),
            port: Some(0),
            user: None,
            identity_file: None,
        })
        .unwrap_err();
        assert_eq!(error.code, SshConnectionErrorCode::InvalidHost);
    }

    #[test]
    fn workspace_cd_supports_home_and_shell_quotes_paths() {
        assert_eq!(workspace_cd_command("~"), "cd \"$HOME\"");
        assert_eq!(
            workspace_cd_command("~/code/pilo"),
            "cd \"$HOME\"/'code/pilo'"
        );
        assert_eq!(
            workspace_cd_command("/srv/it's pilo"),
            "cd '/srv/it'\"'\"'s pilo'"
        );
    }

    #[test]
    fn extracts_path_from_login_environment_with_prefix_noise() {
        let bytes = b"profile banner\nPATH=/home/dev/.local/bin:/usr/bin\0HOME=/home/dev\0";
        assert_eq!(
            environment_value(bytes, "PATH"),
            Some("/home/dev/.local/bin:/usr/bin")
        );
    }

    #[test]
    fn environment_probe_ignores_shell_noise_outside_markers() {
        let payload = br#"Welcome to devbox
__PILO_SSH_ENV_BEGIN__
cwd=/srv/pilo
pi_executable=/home/dev/.local/bin/pi
pi_version=0.85.1
node_executable=/usr/bin/node
node_version=v22.0.0
git_executable=/usr/bin/git
git_version=git version 2.45.0
git_branch=main
__PILO_SSH_ENV_END__
logout noise
"#;
        let environment = parse_environment_probe(payload).unwrap();

        assert_eq!(environment.cwd, "/srv/pilo");
        assert_eq!(environment.git_branch.as_deref(), Some("main"));
        assert_eq!(environment.pi_executable, "/home/dev/.local/bin/pi");
        assert_eq!(environment.node_executable, "/usr/bin/node");
        assert_eq!(environment.git_executable, "/usr/bin/git");
    }

    #[test]
    fn ssh_process_spec_uses_system_openssh_without_pty_or_config_overrides() {
        let target = SshTarget::ConfigHost {
            host: "devbox".to_owned(),
        };
        let spec = ssh_process_spec(
            &target,
            "/srv/pilo",
            "/home/dev/.local/bin:/usr/bin",
            "/home/dev/.local/bin/pi",
        );

        assert_eq!(spec.program, "ssh");
        assert_eq!(spec.cwd, None);
        assert_eq!(spec.stdout_ready_marker.as_deref(), Some(RPC_READY_MARKER));
        assert_eq!(
            &spec.args[..8],
            [
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "RemoteCommand=none",
                "devbox"
            ]
        );
        assert_eq!(spec.args.len(), 9);
        let remote_command = spec.args.last().unwrap();
        assert!(remote_command.contains(RPC_READY_MARKER));
        assert!(remote_command.contains("/home/dev/.local/bin/pi"));
        assert!(remote_command.contains("--mode rpc"));
        assert!(!remote_command.contains("--no-extensions"));
        assert!(!spec.args.iter().any(|arg| arg == "-t" || arg == "-tt"));

        for overridden_option in [
            "-F",
            "IdentityFile=",
            "ProxyJump=",
            "UserKnownHostsFile=",
            "StrictHostKeyChecking=",
        ] {
            assert!(!spec.args.iter().any(|arg| arg.contains(overridden_option)));
        }
    }
}
