use std::{collections::BTreeMap, fs, path::PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::domain::{ConnectionKind, PiRuntime, Project};

use super::{ssh, storage};

const SSH_WORKSPACE_EXTENSION: &str = include_str!("pi_ssh_workspace.js");
const CONFIG_PLACEHOLDER: &str = "__PILO_SSH_WORKSPACE_CONFIG__";

pub(crate) struct PiRuntimeProfile {
    pub project: Project,
    pub extensions: Vec<String>,
    pub disable_builtin_tools: bool,
    pub disable_extension_discovery: bool,
    pub disable_context_files: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshWorkspaceConfig<'a> {
    label: &'a str,
    remote_cwd: &'a str,
    ssh_args: Vec<String>,
    ssh_environment: BTreeMap<String, String>,
}

pub(crate) fn resolve_session_project(
    app: &AppHandle,
    project: &Project,
) -> Result<Project, String> {
    match project.connection.pi_runtime {
        PiRuntime::Workspace => Ok(project.clone()),
        PiRuntime::Local => local_runtime_project(app, project),
    }
}

pub(crate) fn resolve_pi_runtime(
    app: &AppHandle,
    project: &Project,
    mut extensions: Vec<String>,
) -> Result<PiRuntimeProfile, String> {
    match project.connection.pi_runtime {
        PiRuntime::Workspace => Ok(PiRuntimeProfile {
            project: project.clone(),
            extensions,
            disable_builtin_tools: false,
            disable_extension_discovery: false,
            disable_context_files: false,
        }),
        PiRuntime::Local => {
            let runtime_project = local_runtime_project(app, project)?;
            let ConnectionKind::Ssh { target } = &project.connection.kind else {
                return Err("Local Pi with a remote workspace requires an SSH project".to_owned());
            };
            if !project.path.starts_with('/') {
                return Err(
                    "Local Pi SSH workspace currently requires a POSIX remote project path"
                        .to_owned(),
                );
            }
            let config = SshWorkspaceConfig {
                label: &project.connection.name,
                remote_cwd: &project.path,
                ssh_args: ssh::ssh_base_args(target)?,
                ssh_environment: ssh::ssh_child_environment(&project.connection)?,
            };
            let config_json = serde_json::to_string(&config)
                .map_err(|error| format!("failed to encode SSH workspace config: {error}"))?;
            // Load Pilo's workspace router last so a project extension cannot
            // accidentally restore local filesystem tools for an SSH workspace.
            extensions.push(SSH_WORKSPACE_EXTENSION.replace(CONFIG_PLACEHOLDER, &config_json));
            Ok(PiRuntimeProfile {
                project: runtime_project,
                extensions,
                disable_builtin_tools: true,
                disable_extension_discovery: true,
                disable_context_files: true,
            })
        }
    }
}

fn local_runtime_project(app: &AppHandle, project: &Project) -> Result<Project, String> {
    if !matches!(project.connection.kind, ConnectionKind::Ssh { .. }) {
        return Err("Local Pi runtime is only valid for SSH projects".to_owned());
    }
    let db = storage::open(app)?;
    let local_connection = storage::ensure_local_connection(&db)?;
    let path = local_session_anchor(app, &project.id)?;
    let mut runtime_project = project.clone();
    runtime_project.path = path.to_string_lossy().into_owned();
    runtime_project.connection = local_connection;
    runtime_project.metadata.cwd = runtime_project.path.clone();
    runtime_project.metadata.git_branch = None;
    Ok(runtime_project)
}

fn local_session_anchor(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let path = session_anchor_path(app, project_id)?;
    fs::create_dir_all(&path)
        .map_err(|error| format!("failed to create local Pi workspace anchor: {error}"))?;
    Ok(path)
}

fn session_anchor_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve Pilo app data directory: {error}"))?;
    Ok(app_data
        .join("pi-workspaces")
        .join(format!("{:016x}", fnv1a_64(project_id.as_bytes()))))
}

/// Remove the local anchor directory that holds a Local-Pi project's session
/// files, so a re-added project does not resurrect the previous sessions.
pub(crate) fn remove_session_anchor(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let path = session_anchor_path(app, project_id)?;
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove local Pi workspace anchor: {error}"
        )),
    }
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::fnv1a_64;

    #[test]
    fn project_anchor_hash_is_stable() {
        assert_eq!(fnv1a_64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63dc4c8601ec8c);
    }
}
