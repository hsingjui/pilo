use std::{collections::BTreeMap, fs};

use serde::Serialize;
use tauri::AppHandle;

use crate::domain::{ConnectionKind, PiRuntime, Project};

use super::{host_paths::HostPaths, ssh, storage};

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
    resolve_session_project_with_paths(&HostPaths::from_app(app)?, project)
}

pub(crate) fn resolve_session_project_with_paths(
    paths: &HostPaths,
    project: &Project,
) -> Result<Project, String> {
    match project.connection.pi_runtime {
        PiRuntime::Workspace => Ok(project.clone()),
        PiRuntime::Local => local_runtime_project(paths, project),
    }
}

pub(crate) fn resolve_pi_runtime(
    app: &AppHandle,
    project: &Project,
    extensions: Vec<String>,
) -> Result<PiRuntimeProfile, String> {
    resolve_pi_runtime_with_paths(&HostPaths::from_app(app)?, project, extensions)
}

pub(crate) fn resolve_pi_runtime_with_paths(
    paths: &HostPaths,
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
            let runtime_project = local_runtime_project(paths, project)?;
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

fn local_runtime_project(paths: &HostPaths, project: &Project) -> Result<Project, String> {
    if !matches!(project.connection.kind, ConnectionKind::Ssh { .. }) {
        return Err("Local Pi runtime is only valid for SSH projects".to_owned());
    }
    let db = storage::open_with_paths(paths)?;
    let local_connection = storage::ensure_local_connection(&db)?;
    let path = local_session_anchor(paths, &project.id)?;
    let mut runtime_project = project.clone();
    runtime_project.path = path.to_string_lossy().into_owned();
    runtime_project.connection = local_connection;
    runtime_project.metadata.cwd = runtime_project.path.clone();
    runtime_project.metadata.git_branch = None;
    Ok(runtime_project)
}

fn local_session_anchor(paths: &HostPaths, project_id: &str) -> Result<std::path::PathBuf, String> {
    let path = paths.session_anchor_path(project_id);
    fs::create_dir_all(&path)
        .map_err(|error| format!("failed to create local Pi workspace anchor: {error}"))?;
    Ok(path)
}

/// Remove the local anchor directory that holds a Local-Pi project's session
/// files, so a re-added project does not resurrect the previous sessions.
pub(crate) fn remove_session_anchor(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let paths = HostPaths::from_app(app)?;
    let path = paths.session_anchor_path(project_id);
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove local Pi workspace anchor: {error}"
        )),
    }
}
