use std::collections::BTreeSet;

use pilo_protocol::EnvironmentInfo;
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::domain::{Connection, DiscoveredWorkspace, Workspace, WorkspaceMetadata};

use super::{server_client::ServerManager, storage};

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
    servers: &ServerManager,
    connection: Connection,
    path: String,
) -> Result<Workspace, String> {
    let (connection, metadata) = inspect(servers, connection, path).await?;
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

pub async fn refresh(
    app: &AppHandle,
    servers: &ServerManager,
    id: &str,
) -> Result<Workspace, String> {
    let current = get(app, id)?;
    let (connection, metadata) = inspect(servers, current.connection, current.path).await?;
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
    servers: &ServerManager,
    connection: Connection,
) -> Result<Vec<DiscoveredWorkspace>, String> {
    let headers: Vec<Value> = servers
        .request_typed(&connection, "session.discover", Value::Null)
        .await?;
    let existing = list(app)?;
    let added_ids = existing
        .iter()
        .map(|workspace| workspace.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut paths = parse_session_headers(&headers);
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
    servers: &ServerManager,
    connection: Connection,
    path: String,
) -> Result<(Connection, WorkspaceMetadata), String> {
    let environment: EnvironmentInfo = servers
        .request_typed(
            &connection,
            "environment.inspect",
            serde_json::json!({ "workspace": path }),
        )
        .await?;
    Ok((
        connection,
        WorkspaceMetadata {
            cwd: environment.cwd,
            git_branch: environment.git_branch,
            pi_version: environment.pi_version,
            refreshed_at_ms: storage::now_ms(),
        },
    ))
}

#[derive(Deserialize)]
struct SessionHeader {
    #[serde(rename = "type")]
    kind: String,
    cwd: String,
}

fn parse_session_headers(headers: &[Value]) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for value in headers {
        let Ok(header) = serde_json::from_value::<SessionHeader>(value.clone()) else {
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
        let headers = vec![
            serde_json::json!({"type":"session","version":3,"cwd":"/root/code/pilo"}),
            serde_json::json!({"type":"session","version":3,"cwd":"/root/code/pi"}),
            serde_json::json!({"type":"session","version":3,"cwd":"/root/code/pilo"}),
            serde_json::json!({"type":"message","cwd":"/ignore"}),
        ];
        assert_eq!(
            parse_session_headers(&headers),
            vec!["/root/code/pi".to_owned(), "/root/code/pilo".to_owned()]
        );
    }
}
