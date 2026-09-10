use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use thiserror::Error;
use tokio::{process::Command, time::timeout};

use crate::domain::{LocalConnection, LocalEnvironmentInfo};

use super::process::ProcessSpec;

const PI_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_BRANCH_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalConnectionErrorCode {
    InvalidWorkspace,
    PiNotFound,
    PiVersionFailed,
    PiSpawnFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct LocalConnectionError {
    pub code: LocalConnectionErrorCode,
    pub message: String,
}

impl LocalConnectionError {
    fn new(code: LocalConnectionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn pi_spawn(error: impl std::fmt::Display) -> Self {
        Self::new(
            LocalConnectionErrorCode::PiSpawnFailed,
            format!("failed to start local Pi RPC: {error}"),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConnectionProbe {
    pub connection: LocalConnection,
    pub environment: LocalEnvironmentInfo,
}

pub(crate) struct LocalLaunchPlan {
    pub connection: LocalConnection,
    pub environment: LocalEnvironmentInfo,
    pub process: ProcessSpec,
}

pub async fn probe_local_connection(
    workspace: PathBuf,
) -> Result<LocalConnectionProbe, LocalConnectionError> {
    let cwd = normalize_workspace(&workspace)?;
    let pi_executable = detect_pi_executable()?;
    let pi_version = detect_pi_version(&pi_executable).await?;
    let git_branch = detect_git_branch(&cwd).await;

    Ok(LocalConnectionProbe {
        connection: LocalConnection::default(),
        environment: LocalEnvironmentInfo {
            cwd,
            git_branch,
            pi_executable,
            pi_version,
        },
    })
}

pub(crate) async fn prepare_local_launch(
    workspace: PathBuf,
) -> Result<LocalLaunchPlan, LocalConnectionError> {
    let probe = probe_local_connection(workspace).await?;
    let process = local_process_spec(&probe.environment.pi_executable, &probe.environment.cwd);

    Ok(LocalLaunchPlan {
        connection: probe.connection,
        environment: probe.environment,
        process,
    })
}

fn normalize_workspace(workspace: &Path) -> Result<PathBuf, LocalConnectionError> {
    let metadata = fs::metadata(workspace).map_err(|error| {
        LocalConnectionError::new(
            LocalConnectionErrorCode::InvalidWorkspace,
            format!(
                "workspace '{}' is not accessible: {error}",
                workspace.display()
            ),
        )
    })?;

    if !metadata.is_dir() {
        return Err(LocalConnectionError::new(
            LocalConnectionErrorCode::InvalidWorkspace,
            format!("workspace '{}' is not a directory", workspace.display()),
        ));
    }

    fs::canonicalize(workspace).map_err(|error| {
        LocalConnectionError::new(
            LocalConnectionErrorCode::InvalidWorkspace,
            format!(
                "failed to resolve workspace '{}': {error}",
                workspace.display()
            ),
        )
    })
}

fn detect_pi_executable() -> Result<PathBuf, LocalConnectionError> {
    let path = env::var_os("PATH");
    let pathext = env::var_os("PATHEXT");

    find_executable_in_path(path.as_deref(), pathext.as_deref(), cfg!(windows)).ok_or_else(|| {
        LocalConnectionError::new(
            LocalConnectionErrorCode::PiNotFound,
            "Pi executable 'pi' was not found in PATH",
        )
    })
}

fn find_executable_in_path(
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    windows: bool,
) -> Option<PathBuf> {
    let path = path?;
    let names = executable_candidate_names("pi", pathext, windows);

    for directory in env::split_paths(path) {
        for name in &names {
            let candidate = directory.join(name);
            if is_executable_file(&candidate) {
                return fs::canonicalize(&candidate).ok().or(Some(candidate));
            }
        }
    }

    None
}

fn executable_candidate_names(
    program: &str,
    pathext: Option<&OsStr>,
    windows: bool,
) -> Vec<OsString> {
    if !windows {
        return vec![OsString::from(program)];
    }

    let mut names = vec![OsString::from(program)];
    let extensions = pathext
        .and_then(OsStr::to_str)
        .unwrap_or(".COM;.EXE;.BAT;.CMD");

    for extension in extensions
        .split(';')
        .filter(|extension| !extension.is_empty())
    {
        names.push(OsString::from(format!("{program}{extension}")));
    }

    names
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

async fn detect_pi_version(executable: &Path) -> Result<String, LocalConnectionError> {
    let mut command = Command::new(executable);
    command.arg("--version");

    let output = timeout(PI_VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            LocalConnectionError::new(
                LocalConnectionErrorCode::PiVersionFailed,
                format!(
                    "timed out while detecting Pi version with '{}'",
                    executable.display()
                ),
            )
        })?
        .map_err(|error| {
            LocalConnectionError::new(
                LocalConnectionErrorCode::PiVersionFailed,
                format!(
                    "failed to run '{}' --version: {error}",
                    executable.display()
                ),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let suffix = if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        };
        return Err(LocalConnectionError::new(
            LocalConnectionErrorCode::PiVersionFailed,
            format!("Pi version probe exited with {}{suffix}", output.status),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };

    if version.is_empty() {
        return Err(LocalConnectionError::new(
            LocalConnectionErrorCode::PiVersionFailed,
            "Pi version probe returned no version text",
        ));
    }

    Ok(version.to_owned())
}

async fn detect_git_branch(workspace: &Path) -> Option<String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(workspace)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"]);

    let output = timeout(GIT_BRANCH_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!branch.is_empty()).then_some(branch)
}

fn local_process_spec(pi_executable: &Path, cwd: &Path) -> ProcessSpec {
    ProcessSpec {
        program: pi_executable.to_string_lossy().into_owned(),
        args: vec!["--mode".to_owned(), "rpc".to_owned()],
        cwd: Some(cwd.to_path_buf()),
        env: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("pilo-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn local_process_spec_runs_rpc_in_workspace_without_disabling_extensions() {
        let spec = local_process_spec(Path::new("/tools/pi"), Path::new("/workspace"));

        assert_eq!(spec.program, "/tools/pi");
        assert_eq!(spec.args, ["--mode", "rpc"]);
        assert_eq!(spec.cwd, Some(PathBuf::from("/workspace")));
        assert!(!spec.args.iter().any(|arg| arg == "--no-extensions"));
    }

    #[test]
    fn invalid_workspace_has_stable_error_code() {
        let missing = unique_temp_dir("missing-parent").join("missing");
        let error = normalize_workspace(&missing).unwrap_err();

        assert_eq!(error.code, LocalConnectionErrorCode::InvalidWorkspace);
        let _ = fs::remove_dir_all(missing.parent().unwrap());
    }

    #[test]
    fn finds_executable_in_explicit_path() {
        let directory = unique_temp_dir("path-probe");
        let executable = directory.join("pi");
        let mut file = File::create(&executable).unwrap();
        writeln!(file, "#!/bin/sh").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions).unwrap();
        }

        let found = find_executable_in_path(Some(directory.as_os_str()), None, false).unwrap();
        assert_eq!(found, fs::canonicalize(&executable).unwrap());

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detects_pi_version_from_executable() {
        use std::os::unix::fs::PermissionsExt;

        let directory = unique_temp_dir("version-probe");
        let executable = directory.join("pi");
        fs::write(&executable, "#!/bin/sh\nprintf '0.85.1\\n'\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();

        let version = detect_pi_version(&executable).await.unwrap();
        assert_eq!(version, "0.85.1");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn windows_candidate_names_include_pathext() {
        let names = executable_candidate_names("pi", Some(OsStr::new(".EXE;.CMD")), true);
        assert_eq!(
            names,
            vec![
                OsString::from("pi"),
                OsString::from("pi.EXE"),
                OsString::from("pi.CMD")
            ]
        );
    }
}
