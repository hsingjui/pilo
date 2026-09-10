use std::{
    collections::BTreeSet,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use tauri::AppHandle;

use crate::domain::{
    Connection, ConnectionKind, DiscoveredWorkspace, Workspace, WorkspaceMetadata,
};

use super::{
    local::probe_local_connection,
    ssh::{discover_ssh_session_headers, probe_ssh_connection},
    storage,
    wsl::{discover_wsl_session_headers, probe_wsl_connection},
};

const MAX_DISCOVERED_WORKSPACES: usize = 200;

pub fn list(app: &AppHandle) -> Result<Vec<Workspace>, String> {
    storage::list_workspaces(&storage::open(app)?)
}

pub fn get(app: &AppHandle, id: &str) -> Result<Workspace, String> {
    storage::get_workspace(&storage::open(app)?, id)?
        .ok_or_else(|| format!("Workspace '{id}' was not found"))
}

pub async fn add(
    app: &AppHandle,
    connection: Connection,
    path: String,
) -> Result<Workspace, String> {
    let (connection, metadata) = inspect(connection, path).await?;
    let normalized_path = metadata.cwd.clone();
    let id = Workspace::stable_id(&connection.id, &normalized_path);
    let db = storage::open(app)?;
    let now = storage::now_ms();
    let created_at_ms = storage::get_workspace(&db, &id)?
        .map(|workspace| workspace.created_at_ms)
        .unwrap_or(now);
    let workspace = Workspace {
        id,
        name: Workspace::name_from_path(&normalized_path),
        path: normalized_path,
        connection,
        metadata,
        created_at_ms,
        last_opened_at_ms: now,
    };
    storage::upsert_workspace(&db, &workspace)?;
    Ok(workspace)
}

pub async fn refresh(app: &AppHandle, id: &str) -> Result<Workspace, String> {
    let current = get(app, id)?;
    let (connection, metadata) = inspect(current.connection, current.path).await?;
    let normalized_path = metadata.cwd.clone();
    let workspace = Workspace {
        id: current.id,
        name: Workspace::name_from_path(&normalized_path),
        path: normalized_path,
        connection,
        metadata,
        created_at_ms: current.created_at_ms,
        last_opened_at_ms: current.last_opened_at_ms,
    };
    storage::upsert_workspace(&storage::open(app)?, &workspace)?;
    Ok(workspace)
}

pub fn touch(app: &AppHandle, id: &str) -> Result<Workspace, String> {
    let mut workspace = get(app, id)?;
    workspace.last_opened_at_ms = storage::now_ms();
    storage::upsert_workspace(&storage::open(app)?, &workspace)?;
    Ok(workspace)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<Vec<Workspace>, String> {
    let db = storage::open(app)?;
    if !storage::remove_workspace(&db, id)? {
        return Err(format!("Workspace '{id}' was not found"));
    }
    storage::list_workspaces(&db)
}

pub async fn discover(
    app: &AppHandle,
    connection: Connection,
) -> Result<Vec<DiscoveredWorkspace>, String> {
    let headers = match connection.kind.clone() {
        ConnectionKind::Local => discover_local_session_headers()?,
        ConnectionKind::Wsl { distro } => discover_wsl_session_headers(distro)
            .await
            .map_err(|error| error.to_string())?,
        ConnectionKind::Ssh { target } => discover_ssh_session_headers(target)
            .await
            .map_err(|error| error.to_string())?,
    };
    let existing = list(app)?;
    let added_ids = existing
        .iter()
        .map(|workspace| workspace.id.as_str())
        .collect::<BTreeSet<_>>();

    let mut paths = parse_session_header_cwds(&headers);
    paths.truncate(MAX_DISCOVERED_WORKSPACES);
    Ok(paths
        .into_iter()
        .map(|path| {
            let id = Workspace::stable_id(&connection.id, &path);
            DiscoveredWorkspace {
                name: Workspace::name_from_path(&path),
                path,
                already_added: added_ids.contains(id.as_str()),
            }
        })
        .collect())
}

async fn inspect(
    connection: Connection,
    path: String,
) -> Result<(Connection, WorkspaceMetadata), String> {
    let refreshed_at_ms = storage::now_ms();
    match connection.kind {
        ConnectionKind::Local => {
            let probe = probe_local_connection(PathBuf::from(path))
                .await
                .map_err(|error| error.to_string())?;
            let cwd = probe.environment.cwd.to_string_lossy().into_owned();
            Ok((
                Connection::from(probe.connection),
                WorkspaceMetadata {
                    cwd,
                    git_branch: probe.environment.git_branch,
                    pi_version: probe.environment.pi_version,
                    refreshed_at_ms,
                },
            ))
        }
        ConnectionKind::Wsl { distro } => {
            let probe = probe_wsl_connection(distro, path)
                .await
                .map_err(|error| error.to_string())?;
            Ok((
                Connection::from(probe.connection),
                WorkspaceMetadata {
                    cwd: probe.environment.cwd,
                    git_branch: probe.environment.git_branch,
                    pi_version: probe.environment.pi_version,
                    refreshed_at_ms,
                },
            ))
        }
        ConnectionKind::Ssh { target } => {
            let probe = probe_ssh_connection(target, path)
                .await
                .map_err(|error| error.to_string())?;
            Ok((
                Connection::from(probe.connection),
                WorkspaceMetadata {
                    cwd: probe.environment.cwd,
                    git_branch: probe.environment.git_branch,
                    pi_version: probe.environment.pi_version,
                    refreshed_at_ms,
                },
            ))
        }
    }
}

fn local_pi_agent_dir() -> Option<PathBuf> {
    env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent")))
        .or_else(|| env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".pi/agent")))
}

fn discover_local_session_headers() -> Result<Vec<u8>, String> {
    let Some(agent_dir) = local_pi_agent_dir() else {
        return Ok(Vec::new());
    };
    let sessions_dir = agent_dir.join("sessions");
    let Ok(workspace_dirs) = fs::read_dir(&sessions_dir) else {
        return Ok(Vec::new());
    };

    let mut headers = Vec::new();
    let mut count = 0usize;
    for workspace_dir in workspace_dirs.flatten() {
        let path = workspace_dir.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(path) else {
            continue;
        };
        for file in files.flatten() {
            if count >= 500 {
                return Ok(headers);
            }
            let path = file.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(line) = read_first_line(&path) {
                headers.extend_from_slice(line.as_bytes());
                headers.push(b'\n');
                count += 1;
            }
        }
    }
    Ok(headers)
}

fn read_first_line(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    (!line.trim().is_empty()).then_some(line)
}

#[derive(Deserialize)]
struct SessionHeader {
    #[serde(rename = "type")]
    kind: String,
    cwd: String,
}

fn parse_session_header_cwds(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut paths = BTreeSet::new();
    for line in text.lines() {
        let Ok(header) = serde_json::from_str::<SessionHeader>(line.trim()) else {
            continue;
        };
        if header.kind == "session" && !header.cwd.trim().is_empty() {
            paths.insert(header.cwd);
        }
    }
    paths.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unique_workspace_paths_from_session_headers() {
        let headers = br#"banner
{"type":"session","version":3,"cwd":"/root/code/pilo"}
{"type":"session","version":3,"cwd":"/root/code/pi"}
{"type":"session","version":3,"cwd":"/root/code/pilo"}
{"type":"message","cwd":"/ignore"}
"#;

        assert_eq!(
            parse_session_header_cwds(headers),
            vec!["/root/code/pi".to_owned(), "/root/code/pilo".to_owned()]
        );
    }
}
