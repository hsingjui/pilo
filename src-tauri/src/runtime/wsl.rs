use std::{collections::HashSet, time::Duration};

use serde::Serialize;
use thiserror::Error;
use tokio::{process::Command, time::timeout};

use crate::domain::{WslConnection, WslDistribution, WslEnvironmentInfo};

use super::process::ProcessSpec;

const WSL_PROGRAM: &str = "wsl.exe";
const WSL_LIST_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_BEGIN: &str = "__PILO_WSL_ENV_BEGIN__";
const PROBE_END: &str = "__PILO_WSL_ENV_END__";

const ENVIRONMENT_PROBE_SCRIPT: &str = r#"
pi_path="$(command -v pi 2>/dev/null || true)"
node_path="$(command -v node 2>/dev/null || true)"
git_path="$(command -v git 2>/dev/null || true)"

printf '__PILO_WSL_ENV_BEGIN__\n'
printf 'cwd=%s\n' "$PWD"
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
printf '__PILO_WSL_ENV_END__\n'
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WslConnectionErrorCode {
    WslUnavailable,
    DistroListFailed,
    DistroNotFound,
    InvalidWorkspace,
    EnvironmentProbeFailed,
    PiNotFound,
    NodeNotFound,
    GitNotFound,
    PiSpawnFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct WslConnectionError {
    pub code: WslConnectionErrorCode,
    pub message: String,
}

impl WslConnectionError {
    fn new(code: WslConnectionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn pi_spawn(error: impl std::fmt::Display) -> Self {
        Self::new(
            WslConnectionErrorCode::PiSpawnFailed,
            format!("failed to start WSL Pi RPC: {error}"),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConnectionProbe {
    pub connection: WslConnection,
    pub environment: WslEnvironmentInfo,
}

pub(crate) struct WslLaunchPlan {
    pub connection: WslConnection,
    pub environment: WslEnvironmentInfo,
    pub process: ProcessSpec,
}

pub async fn list_wsl_distributions() -> Result<Vec<WslDistribution>, WslConnectionError> {
    let output = timeout(
        WSL_LIST_TIMEOUT,
        Command::new(WSL_PROGRAM)
            .args(["--list", "--quiet"])
            .output(),
    )
    .await
    .map_err(|_| {
        WslConnectionError::new(
            WslConnectionErrorCode::DistroListFailed,
            "timed out while listing WSL distributions",
        )
    })?
    .map_err(|error| {
        WslConnectionError::new(
            WslConnectionErrorCode::WslUnavailable,
            format!("failed to run '{WSL_PROGRAM} --list --quiet': {error}"),
        )
    })?;

    if !output.status.success() {
        let stderr = decode_wsl_text(&output.stderr);
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::DistroListFailed,
            format_command_failure("WSL distro list", output.status.to_string(), &stderr),
        ));
    }

    Ok(parse_wsl_distribution_list(&output.stdout))
}

pub async fn probe_wsl_connection(
    distro: String,
    workspace: String,
) -> Result<WslConnectionProbe, WslConnectionError> {
    let (connection, environment, _) = inspect_wsl_connection(distro, workspace).await?;
    Ok(WslConnectionProbe {
        connection,
        environment,
    })
}

pub async fn discover_wsl_session_headers(distro: String) -> Result<Vec<u8>, WslConnectionError> {
    let distro = normalize_distro(&distro)?;
    ensure_distro_exists(&distro).await?;
    let script = r#"
sessions_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$sessions_dir" ] || exit 0
find "$sessions_dir" -type f -name '*.jsonl' -exec sed -n '1p' {} \; 2>/dev/null | head -n 500
"#;
    let args = vec![
        "--distribution".to_owned(),
        distro,
        "--exec".to_owned(),
        "/bin/sh".to_owned(),
        "-c".to_owned(),
        script.to_owned(),
    ];
    run_wsl_probe(&args).await
}

pub async fn scan_wsl_session_files(distro: String) -> Result<Vec<u8>, WslConnectionError> {
    let distro = normalize_distro(&distro)?;
    ensure_distro_exists(&distro).await?;
    let script = r#"
sessions_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$sessions_dir" ] || exit 0
find "$sessions_dir" -type f -name '*.jsonl' | while IFS= read -r file; do
  size="$(stat -c %s "$file" 2>/dev/null || printf 0)"
  mtime="$(date -d "$(stat -c %y "$file" 2>/dev/null)" +%s%N 2>/dev/null || printf 0)"
  printf '\036%s\t%s\t%s\n' "$file" "$size" "$mtime"
  sed -n '1p' "$file" 2>/dev/null || true
done
"#;
    let args = vec![
        "--distribution".to_owned(),
        distro,
        "--exec".to_owned(),
        "/bin/sh".to_owned(),
        "-c".to_owned(),
        script.to_owned(),
    ];
    run_wsl_probe(&args).await
}

pub async fn read_wsl_session_file(
    distro: String,
    path: String,
    offset: u64,
) -> Result<Vec<u8>, WslConnectionError> {
    let distro = normalize_distro(&distro)?;
    ensure_distro_exists(&distro).await?;
    let start = offset.saturating_add(1);
    let args = vec![
        "--distribution".to_owned(),
        distro,
        "--exec".to_owned(),
        "tail".to_owned(),
        "-c".to_owned(),
        format!("+{start}"),
        "--".to_owned(),
        path,
    ];
    run_wsl_probe(&args).await
}

pub(crate) async fn prepare_wsl_launch(
    distro: String,
    workspace: String,
) -> Result<WslLaunchPlan, WslConnectionError> {
    let (connection, environment, path) = inspect_wsl_connection(distro, workspace).await?;
    let process = wsl_process_spec(
        &connection.distro,
        &environment.cwd,
        &path,
        &environment.pi_executable,
    );

    Ok(WslLaunchPlan {
        connection,
        environment,
        process,
    })
}

async fn inspect_wsl_connection(
    distro: String,
    workspace: String,
) -> Result<(WslConnection, WslEnvironmentInfo, String), WslConnectionError> {
    let distro = normalize_distro(&distro)?;
    let workspace = normalize_workspace(&workspace)?;
    ensure_distro_exists(&distro).await?;

    let base_environment = read_base_environment(&distro, &workspace).await?;
    let login_shell = environment_value(&base_environment, "SHELL").unwrap_or("/bin/sh");
    let login_environment = read_login_environment(&distro, &workspace, login_shell).await?;
    let path = environment_value(&login_environment, "PATH")
        .or_else(|| environment_value(&base_environment, "PATH"))
        .ok_or_else(|| {
            WslConnectionError::new(
                WslConnectionErrorCode::EnvironmentProbeFailed,
                format!("WSL distro '{distro}' did not expose PATH"),
            )
        })?
        .to_owned();

    let environment = probe_environment_with_path(&distro, &workspace, &path).await?;
    validate_environment(&distro, &environment)?;

    Ok((WslConnection::new(distro), environment, path))
}

fn normalize_distro(distro: &str) -> Result<String, WslConnectionError> {
    let distro = distro.trim();
    if distro.is_empty() {
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::DistroNotFound,
            "WSL distribution name cannot be empty",
        ));
    }
    Ok(distro.to_owned())
}

fn normalize_workspace(workspace: &str) -> Result<String, WslConnectionError> {
    let workspace = workspace.trim();
    if workspace.is_empty() {
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::InvalidWorkspace,
            "WSL workspace path cannot be empty",
        ));
    }
    if !workspace.starts_with('/') && workspace != "~" && !workspace.starts_with("~/") {
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::InvalidWorkspace,
            format!("WSL workspace '{workspace}' must be a Linux absolute path or '~' path"),
        ));
    }
    Ok(workspace.to_owned())
}

async fn ensure_distro_exists(distro: &str) -> Result<(), WslConnectionError> {
    let distributions = list_wsl_distributions().await?;
    if distributions
        .iter()
        .any(|distribution| distribution.name == distro)
    {
        return Ok(());
    }

    Err(WslConnectionError::new(
        WslConnectionErrorCode::DistroNotFound,
        format!("WSL distribution '{distro}' is not installed"),
    ))
}

async fn read_base_environment(
    distro: &str,
    workspace: &str,
) -> Result<Vec<u8>, WslConnectionError> {
    let args = vec![
        "--distribution".to_owned(),
        distro.to_owned(),
        "--cd".to_owned(),
        workspace.to_owned(),
        "--exec".to_owned(),
        "/usr/bin/env".to_owned(),
        "-0".to_owned(),
    ];
    let output = run_wsl_probe(&args)
        .await
        .map_err(|error| match error.code {
            WslConnectionErrorCode::EnvironmentProbeFailed => WslConnectionError::new(
                WslConnectionErrorCode::InvalidWorkspace,
                format!(
                    "WSL workspace '{workspace}' is not accessible in '{distro}': {}",
                    error.message
                ),
            ),
            _ => error,
        })?;
    Ok(output)
}

async fn read_login_environment(
    distro: &str,
    workspace: &str,
    login_shell: &str,
) -> Result<Vec<u8>, WslConnectionError> {
    let args = vec![
        "--distribution".to_owned(),
        distro.to_owned(),
        "--cd".to_owned(),
        workspace.to_owned(),
        "--exec".to_owned(),
        login_shell.to_owned(),
        "-l".to_owned(),
        "-i".to_owned(),
        "-c".to_owned(),
        "/usr/bin/env -0".to_owned(),
    ];
    run_wsl_probe(&args).await.map_err(|error| {
        WslConnectionError::new(
            WslConnectionErrorCode::EnvironmentProbeFailed,
            format!(
                "failed to load login environment with '{login_shell}': {}",
                error.message
            ),
        )
    })
}

async fn probe_environment_with_path(
    distro: &str,
    workspace: &str,
    path: &str,
) -> Result<WslEnvironmentInfo, WslConnectionError> {
    let args = vec![
        "--distribution".to_owned(),
        distro.to_owned(),
        "--cd".to_owned(),
        workspace.to_owned(),
        "--exec".to_owned(),
        "/usr/bin/env".to_owned(),
        format!("PATH={path}"),
        "/bin/sh".to_owned(),
        "-c".to_owned(),
        ENVIRONMENT_PROBE_SCRIPT.to_owned(),
    ];
    let output = run_wsl_probe(&args).await?;
    parse_environment_probe(&output)
}

async fn run_wsl_probe(args: &[String]) -> Result<Vec<u8>, WslConnectionError> {
    let output = timeout(
        WSL_PROBE_TIMEOUT,
        Command::new(WSL_PROGRAM).args(args).output(),
    )
    .await
    .map_err(|_| {
        WslConnectionError::new(
            WslConnectionErrorCode::EnvironmentProbeFailed,
            "timed out while probing WSL environment",
        )
    })?
    .map_err(|error| {
        WslConnectionError::new(
            WslConnectionErrorCode::WslUnavailable,
            format!("failed to run '{WSL_PROGRAM}': {error}"),
        )
    })?;

    if !output.status.success() {
        let stderr = decode_wsl_text(&output.stderr);
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::EnvironmentProbeFailed,
            format_command_failure("WSL environment probe", output.status.to_string(), &stderr),
        ));
    }

    Ok(output.stdout)
}

fn validate_environment(
    distro: &str,
    environment: &WslEnvironmentInfo,
) -> Result<(), WslConnectionError> {
    if environment.pi_executable.is_empty() {
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::PiNotFound,
            format!("Pi executable 'pi' was not found in WSL distro '{distro}' login PATH"),
        ));
    }
    if environment.node_executable.is_empty() {
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::NodeNotFound,
            format!("Node executable 'node' was not found in WSL distro '{distro}' login PATH"),
        ));
    }
    if environment.git_executable.is_empty() {
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::GitNotFound,
            format!("Git executable 'git' was not found in WSL distro '{distro}' login PATH"),
        ));
    }

    for (tool, version) in [
        ("Pi", environment.pi_version.as_str()),
        ("Node", environment.node_version.as_str()),
        ("Git", environment.git_version.as_str()),
    ] {
        if version.is_empty() {
            return Err(WslConnectionError::new(
                WslConnectionErrorCode::EnvironmentProbeFailed,
                format!("{tool} version probe returned no version text in WSL distro '{distro}'"),
            ));
        }
    }

    Ok(())
}

fn wsl_process_spec(distro: &str, cwd: &str, path: &str, pi_executable: &str) -> ProcessSpec {
    ProcessSpec {
        program: WSL_PROGRAM.to_owned(),
        args: vec![
            "--distribution".to_owned(),
            distro.to_owned(),
            "--cd".to_owned(),
            cwd.to_owned(),
            "--exec".to_owned(),
            "/usr/bin/env".to_owned(),
            format!("PATH={path}"),
            pi_executable.to_owned(),
            "--mode".to_owned(),
            "rpc".to_owned(),
        ],
        cwd: None,
        env: Default::default(),
        stdout_ready_marker: None,
    }
}

fn parse_wsl_distribution_list(bytes: &[u8]) -> Vec<WslDistribution> {
    let text = decode_wsl_text(bytes);
    let mut seen = HashSet::new();
    text.lines()
        .map(str::trim)
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .filter(|line| !line.is_empty())
        .filter(|line| seen.insert((*line).to_owned()))
        .map(|name| WslDistribution {
            name: name.to_owned(),
        })
        .collect()
}

fn decode_wsl_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    let looks_utf16_le =
        bytes.len() >= 2 && (bytes.starts_with(&[0xff, 0xfe]) || bytes.contains(&0));

    if looks_utf16_le {
        let offset = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        let units = bytes[offset..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units)
            .trim_matches('\0')
            .to_owned();
    }

    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .trim_matches('\0')
        .to_owned()
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

fn parse_environment_probe(bytes: &[u8]) -> Result<WslEnvironmentInfo, WslConnectionError> {
    let text = String::from_utf8_lossy(bytes);
    let body = text
        .split_once(PROBE_BEGIN)
        .and_then(|(_, tail)| tail.split_once(PROBE_END).map(|(body, _)| body))
        .ok_or_else(|| {
            WslConnectionError::new(
                WslConnectionErrorCode::EnvironmentProbeFailed,
                "WSL environment probe returned an unexpected payload",
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
    Ok(WslEnvironmentInfo {
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
    fn parses_utf16le_wsl_distribution_output() {
        let text = "Debian\r\nUbuntu-24.04\r\n";
        let bytes = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        assert_eq!(
            parse_wsl_distribution_list(&bytes),
            vec![
                WslDistribution {
                    name: "Debian".to_owned()
                },
                WslDistribution {
                    name: "Ubuntu-24.04".to_owned()
                }
            ]
        );
    }

    #[test]
    fn parses_utf8_wsl_distribution_output_and_deduplicates() {
        let distributions = parse_wsl_distribution_list(b"Debian\n\nDebian\nUbuntu\n");
        assert_eq!(
            distributions,
            vec![
                WslDistribution {
                    name: "Debian".to_owned()
                },
                WslDistribution {
                    name: "Ubuntu".to_owned()
                }
            ]
        );
    }

    #[test]
    fn extracts_path_from_null_delimited_login_environment_with_prefix_noise() {
        let bytes = b"startup noise\nPATH=/custom/bin:/usr/bin\0HOME=/home/dev\0";
        assert_eq!(
            environment_value(bytes, "PATH"),
            Some("/custom/bin:/usr/bin")
        );
    }

    #[test]
    fn environment_probe_parses_machine_payload() {
        let payload = br#"noise
__PILO_WSL_ENV_BEGIN__
cwd=/work/pilo
pi_executable=/home/dev/.local/bin/pi
pi_version=0.85.1
node_executable=/usr/bin/node
node_version=v22.0.0
git_executable=/usr/bin/git
git_version=git version 2.45.0
git_branch=main
__PILO_WSL_ENV_END__
"#;
        let environment = parse_environment_probe(payload).unwrap();

        assert_eq!(environment.cwd, "/work/pilo");
        assert_eq!(environment.git_branch.as_deref(), Some("main"));
        assert_eq!(environment.pi_executable, "/home/dev/.local/bin/pi");
        assert_eq!(environment.node_executable, "/usr/bin/node");
        assert_eq!(environment.git_executable, "/usr/bin/git");
    }

    #[test]
    fn wsl_process_spec_uses_direct_exec_without_windows_cwd_or_shell() {
        let spec = wsl_process_spec(
            "Debian",
            "/root/code/pilo",
            "/custom/bin:/usr/bin",
            "/custom/bin/pi",
        );

        assert_eq!(spec.program, "wsl.exe");
        assert_eq!(spec.cwd, None);
        assert_eq!(
            spec.args,
            [
                "--distribution",
                "Debian",
                "--cd",
                "/root/code/pilo",
                "--exec",
                "/usr/bin/env",
                "PATH=/custom/bin:/usr/bin",
                "/custom/bin/pi",
                "--mode",
                "rpc"
            ]
        );
        assert!(!spec.args.iter().any(|arg| arg.contains("sh -")));
    }

    #[test]
    fn rejects_windows_style_workspace_paths() {
        let error = normalize_workspace(r"C:\\Code\\pilo").unwrap_err();
        assert_eq!(error.code, WslConnectionErrorCode::InvalidWorkspace);
    }
}
