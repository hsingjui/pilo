use std::{
    collections::BTreeSet,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::domain::{
    Connection, ConnectionKind, DiscoveredWorkspace, Workspace, WorkspaceMetadata,
};

use super::{
    local::probe_local_connection,
    ssh::{discover_ssh_session_headers, probe_ssh_connection},
    wsl::{discover_wsl_session_headers, probe_wsl_connection},
};

const WORKSPACES_FILE_NAME: &str = "workspaces.json";
const MAX_DISCOVERED_WORKSPACES: usize = 200;
static WORKSPACE_STORE_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "failed to create Pilo app data directory '{}': {error}",
            dir.display()
        )
    })?;
    Ok(dir.join(WORKSPACES_FILE_NAME))
}

fn lock_store() -> Result<MutexGuard<'static, ()>, String> {
    WORKSPACE_STORE_LOCK
        .lock()
        .map_err(|_| "Workspace cache lock is poisoned".to_owned())
}

fn list_unlocked(app: &AppHandle) -> Result<Vec<Workspace>, String> {
    let path = workspace_file(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let value = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
    let mut workspaces: Vec<Workspace> = serde_json::from_str(&value)
        .map_err(|error| format!("failed to parse '{}': {error}", path.display()))?;
    sort_recent(&mut workspaces);
    Ok(workspaces)
}

pub fn list(app: &AppHandle) -> Result<Vec<Workspace>, String> {
    let _guard = lock_store()?;
    list_unlocked(app)
}

pub fn get(app: &AppHandle, id: &str) -> Result<Workspace, String> {
    let _guard = lock_store()?;
    list_unlocked(app)?
        .into_iter()
        .find(|workspace| workspace.id == id)
        .ok_or_else(|| format!("Workspace '{id}' was not found"))
}

fn save_unlocked(app: &AppHandle, workspaces: &[Workspace]) -> Result<(), String> {
    let path = workspace_file(app)?;
    let temp_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(workspaces)
        .map_err(|error| format!("failed to encode Workspace cache: {error}"))?;

    let mut file = fs::File::create(&temp_path)
        .map_err(|error| format!("failed to create '{}': {error}", temp_path.display()))?;
    file.write_all(&bytes)
        .map_err(|error| format!("failed to write '{}': {error}", temp_path.display()))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync '{}': {error}", temp_path.display()))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("failed to replace '{}': {error}", path.display()))?;
    }
    fs::rename(&temp_path, &path).map_err(|error| {
        format!(
            "failed to move Workspace cache '{}' to '{}': {error}",
            temp_path.display(),
            path.display()
        )
    })
}

pub async fn add(
    app: &AppHandle,
    connection: Connection,
    path: String,
) -> Result<Workspace, String> {
    let (connection, metadata) = inspect(connection, path).await?;
    let normalized_path = metadata.cwd.clone();
    let id = Workspace::stable_id(&connection.id, &normalized_path);
    let _guard = lock_store()?;
    let mut all = list_unlocked(app)?;
    let now = now_ms();

    if let Some(existing) = all.iter_mut().find(|workspace| workspace.id == id) {
        existing.name = Workspace::name_from_path(&normalized_path);
        existing.path = normalized_path;
        existing.connection = connection;
        existing.metadata = metadata;
        existing.last_opened_at_ms = now;
        let result = existing.clone();
        sort_recent(&mut all);
        save_unlocked(app, &all)?;
        return Ok(result);
    }

    let workspace = Workspace {
        id,
        name: Workspace::name_from_path(&normalized_path),
        path: normalized_path,
        connection,
        metadata,
        created_at_ms: now,
        last_opened_at_ms: now,
    };
    all.push(workspace.clone());
    sort_recent(&mut all);
    save_unlocked(app, &all)?;
    Ok(workspace)
}

pub async fn refresh(app: &AppHandle, id: &str) -> Result<Workspace, String> {
    let current = get(app, id)?;
    let (connection, metadata) = inspect(current.connection, current.path).await?;
    let normalized_path = metadata.cwd.clone();

    let _guard = lock_store()?;
    let mut all = list_unlocked(app)?;
    let index = all
        .iter()
        .position(|workspace| workspace.id == id)
        .ok_or_else(|| format!("Workspace '{id}' was not found"))?;

    all[index].connection = connection;
    all[index].path = normalized_path.clone();
    all[index].name = Workspace::name_from_path(&normalized_path);
    all[index].metadata = metadata;
    let result = all[index].clone();
    sort_recent(&mut all);
    save_unlocked(app, &all)?;
    Ok(result)
}

pub fn touch(app: &AppHandle, id: &str) -> Result<Workspace, String> {
    let _guard = lock_store()?;
    let mut all = list_unlocked(app)?;
    let workspace = all
        .iter_mut()
        .find(|workspace| workspace.id == id)
        .ok_or_else(|| format!("Workspace '{id}' was not found"))?;
    workspace.last_opened_at_ms = now_ms();
    let result = workspace.clone();
    sort_recent(&mut all);
    save_unlocked(app, &all)?;
    Ok(result)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<Vec<Workspace>, String> {
    let _guard = lock_store()?;
    let mut all = list_unlocked(app)?;
    let previous_len = all.len();
    all.retain(|workspace| workspace.id != id);
    if all.len() == previous_len {
        return Err(format!("Workspace '{id}' was not found"));
    }
    sort_recent(&mut all);
    save_unlocked(app, &all)?;
    Ok(all)
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
    let refreshed_at_ms = now_ms();
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

fn sort_recent(workspaces: &mut [Workspace]) {
    workspaces.sort_by(|left, right| {
        right
            .last_opened_at_ms
            .cmp(&left.last_opened_at_ms)
            .then_with(|| left.name.cmp(&right.name))
    });
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
