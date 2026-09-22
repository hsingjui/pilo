use std::collections::BTreeSet;

use pilo_protocol::EnvironmentInfo;
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::domain::{Connection, DiscoveredProject, Project, ProjectMetadata};

use super::{pi_workspace, server_client::ServerManager, storage};

const MAX_DISCOVERED_PROJECTS: usize = 200;

pub fn list(app: &AppHandle) -> Result<Vec<Project>, String> {
    storage::list_projects(&storage::open(app)?)
}

pub fn get(app: &AppHandle, id: &str) -> Result<Project, String> {
    storage::get_project(&storage::open(app)?, id)?
        .ok_or_else(|| format!("Project '{id}' was not found"))
}

pub async fn add(
    app: &AppHandle,
    servers: &ServerManager,
    connection_id: String,
    path: String,
) -> Result<Project, String> {
    let connection = resolve_connection(app, &connection_id)?;
    let (connection, metadata) = inspect(servers, connection, path).await?;
    let normalized_path = metadata.cwd.clone();
    let id = Project::stable_id(&connection.id, &normalized_path);
    let db = storage::open(app)?;
    let now = storage::now_ms();
    let created_at_ms = storage::get_project(&db, &id)?
        .map(|project| project.created_at_ms)
        .unwrap_or(now);
    let project = Project {
        id,
        name: Project::name_from_path(&normalized_path),
        path: normalized_path,
        connection,
        metadata,
        created_at_ms,
        last_opened_at_ms: now,
    };
    storage::upsert_project(&db, &project)?;
    Ok(project)
}

pub async fn refresh(
    app: &AppHandle,
    servers: &ServerManager,
    id: &str,
) -> Result<Project, String> {
    let current = get(app, id)?;
    let (connection, metadata) = inspect(servers, current.connection, current.path).await?;
    let normalized_path = metadata.cwd.clone();
    let project = Project {
        id: current.id,
        name: Project::name_from_path(&normalized_path),
        path: normalized_path,
        connection,
        metadata,
        created_at_ms: current.created_at_ms,
        last_opened_at_ms: current.last_opened_at_ms,
    };
    storage::upsert_project(&storage::open(app)?, &project)?;
    Ok(project)
}

pub fn touch(app: &AppHandle, id: &str) -> Result<Project, String> {
    let mut project = get(app, id)?;
    project.last_opened_at_ms = storage::now_ms();
    storage::upsert_project(&storage::open(app)?, &project)?;
    Ok(project)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<Vec<Project>, String> {
    let db = storage::open(app)?;
    if !storage::remove_project(&db, id)? {
        return Err(format!("Project '{id}' was not found"));
    }
    pi_workspace::remove_session_anchor(app, id)?;
    storage::list_projects(&db)
}

pub fn reorder(
    app: &AppHandle,
    connection_id: &str,
    project_ids: &[String],
) -> Result<Vec<Project>, String> {
    let mut db = storage::open(app)?;
    storage::reorder_projects(&mut db, connection_id, project_ids)?;
    storage::list_projects(&db)
}

pub async fn discover(
    app: &AppHandle,
    servers: &ServerManager,
    connection_id: String,
) -> Result<Vec<DiscoveredProject>, String> {
    let connection = resolve_connection(app, &connection_id)?;
    let headers: Vec<Value> = servers
        .request_typed(&connection, "session.discover", Value::Null)
        .await?;
    let existing = list(app)?;
    let added_ids = existing
        .iter()
        .map(|project| project.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut paths = parse_session_headers(&headers);
    paths.truncate(MAX_DISCOVERED_PROJECTS);
    Ok(paths
        .into_iter()
        .map(|path| {
            let id = Project::stable_id(&connection.id, &path);
            DiscoveredProject {
                name: Project::name_from_path(&path),
                path,
                already_added: added_ids.contains(id.as_str()),
            }
        })
        .collect())
}

pub fn resolve_connection(app: &AppHandle, connection_id: &str) -> Result<Connection, String> {
    let db = storage::open(app)?;
    if connection_id == "local" {
        return storage::ensure_local_connection(&db);
    }
    storage::get_connection(&db, connection_id)?
        .ok_or_else(|| format!("Connection '{connection_id}' was not found"))
}

async fn inspect(
    servers: &ServerManager,
    connection: Connection,
    path: String,
) -> Result<(Connection, ProjectMetadata), String> {
    let environment: EnvironmentInfo = servers
        .request_typed(
            &connection,
            "environment.inspect",
            serde_json::json!({
                "project": path,
                "piExecutable": connection.pi_executable.clone(),
                "piRuntime": connection.pi_runtime.as_str(),
            }),
        )
        .await?;
    Ok((
        connection,
        ProjectMetadata {
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
    fn parses_unique_project_paths_from_session_headers() {
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
