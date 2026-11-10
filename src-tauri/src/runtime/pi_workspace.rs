use std::fs;

use pilo_protocol::{BuiltinExtension, SshWorkspaceConfig};
use tauri::AppHandle;

use crate::domain::{ConnectionKind, PiRuntime, Project};

use super::{host_paths::HostPaths, ssh, storage};

pub(crate) struct PiRuntimeProfile {
    pub project: Project,
    pub extensions: Vec<String>,
    pub builtin_extensions: Vec<BuiltinExtension>,
    pub disable_builtin_tools: bool,
    pub disable_extension_discovery: bool,
    pub disable_context_files: bool,
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
    if project.default_workspace_pending() {
        return Ok(project.clone());
    }
    match project.connection.pi_runtime {
        PiRuntime::Workspace => Ok(normalize_local_pi_project(project.clone())),
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
    extensions: Vec<String>,
) -> Result<PiRuntimeProfile, String> {
    match project.connection.pi_runtime {
        PiRuntime::Workspace => Ok(PiRuntimeProfile {
            project: normalize_local_pi_project(project.clone()),
            extensions,
            builtin_extensions: Vec::new(),
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
                label: project.connection.name.clone(),
                remote_cwd: project.path.clone(),
                ssh_args: ssh::ssh_base_args(target)?,
                ssh_environment: ssh::ssh_child_environment(&project.connection)?,
            };
            Ok(PiRuntimeProfile {
                project: runtime_project,
                extensions,
                builtin_extensions: vec![BuiltinExtension::SshWorkspace { config }],
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
    Ok(normalize_local_pi_project(runtime_project))
}

fn normalize_local_pi_project(mut project: Project) -> Project {
    if cfg!(windows) && matches!(project.connection.kind, ConnectionKind::Local) {
        // Pi encodes cwd as a directory name; a verbatim prefix leaves an illegal '?'.
        project.path = if let Some(path) = project.path.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{path}")
        } else {
            project
                .path
                .strip_prefix(r"\\?\")
                .unwrap_or(&project.path)
                .to_owned()
        };
        project.metadata.cwd = project.path.clone();
    }
    project
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Connection, ProjectMetadata, SshAuthMethod, SshTarget};

    fn test_project(kind: ConnectionKind, path: &str) -> Project {
        Project {
            id: Project::stable_id("test-connection", path),
            name: "work".to_owned(),
            path: path.to_owned(),
            connection: Connection {
                id: "test-connection".to_owned(),
                name: "Test".to_owned(),
                pi_executable: None,
                pi_runtime: PiRuntime::Workspace,
                kind,
                shown_in_home: true,
            },
            metadata: ProjectMetadata {
                cwd: path.to_owned(),
                git_branch: Some("main".to_owned()),
                pi_version: "1.0.0".to_owned(),
                refreshed_at_ms: 1,
            },
            created_at_ms: 1,
            last_opened_at_ms: 2,
        }
    }

    fn assert_workspace_adapters(project: &Project, expected_path: &str) {
        // Workspace adapters must not need a database or touch this directory.
        let paths = HostPaths::for_test("unused-pi-workspace-test".into());
        let mut expected = project.clone();
        expected.path = expected_path.to_owned();
        expected.metadata.cwd = expected_path.to_owned();

        assert_eq!(
            resolve_session_project_with_paths(&paths, project).unwrap(),
            expected
        );
        assert_eq!(
            resolve_pi_runtime_with_paths(&paths, project, Vec::new())
                .unwrap()
                .project,
            expected
        );
    }

    #[test]
    fn local_workspace_adapters_agree_on_pi_cwd_without_changing_identity() {
        for (path, windows_path) in [
            (r"D:\work", r"D:\work"),
            (r"\\?\D:\work", r"D:\work"),
            (r"\\host\share\work", r"\\host\share\work"),
            (r"\\?\UNC\host\share\work", r"\\host\share\work"),
            ("/home/user/work", "/home/user/work"),
        ] {
            let project = test_project(ConnectionKind::Local, path);
            let expected_path = if cfg!(windows) { windows_path } else { path };
            assert_workspace_adapters(&project, expected_path);
        }
    }

    #[test]
    fn remote_workspace_adapters_leave_paths_unchanged() {
        for kind in [
            ConnectionKind::Wsl {
                distro: "Debian".to_owned(),
            },
            ConnectionKind::Ssh {
                target: SshTarget::ConfigHost {
                    host: "devbox".to_owned(),
                    auth_method: SshAuthMethod::Agent,
                },
            },
        ] {
            for path in ["/srv/work", r"\\?\D:\work", r"\\?\UNC\host\share\work"] {
                let project = test_project(kind.clone(), path);
                assert_workspace_adapters(&project, path);
            }
        }
    }
}
