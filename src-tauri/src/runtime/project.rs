use std::collections::BTreeSet;

use pilo_protocol::EnvironmentInfo;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::domain::{Connection, DiscoveredProject, Project, ProjectMetadata};

use super::{
    events::{RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope},
    pi_workspace,
    server_client::ServerManager,
    storage,
};

const MAX_DISCOVERED_PROJECTS: usize = 200;

pub(crate) fn load_model_scope(
    app: &AppHandle,
    project_id: &str,
) -> Result<crate::domain::ProjectModelScope, String> {
    storage::get_project_model_scope(&storage::open(app)?, project_id)
}

pub(crate) fn save_model_scope(
    app: &AppHandle,
    events: &RuntimeEventBus,
    project_id: &str,
    models: Option<Vec<crate::domain::ProjectScopedModel>>,
) -> Result<crate::domain::ProjectModelScope, String> {
    let scope = storage::set_project_model_scope(&storage::open(app)?, project_id, models)?;
    events.send(RuntimeEventEnvelope {
        session_key: None,
        project_id: Some(project_id.to_owned()),
        timestamp_ms: None,
        event: RuntimeEvent::ProjectModelScopeChanged {
            scope: scope.clone(),
        },
    });
    Ok(scope)
}

pub fn list(app: &AppHandle) -> Result<Vec<Project>, String> {
    let db = storage::open(app)?;
    storage::ensure_local_connection(&db)?;
    for connection in storage::list_connections(&db)? {
        let key = default_workspace_key(&connection.id);
        let root = if cfg!(debug_assertions) {
            ".pilo-dev"
        } else {
            ".pilo"
        };
        let path = format!("~/{root}/workspaces/{key}");
        let now = storage::now_ms();
        let project = Project {
            id: Project::default_workspace_id(&connection.id),
            name: "Default workspace".to_owned(),
            path: path.clone(),
            connection,
            metadata: ProjectMetadata {
                cwd: path,
                git_branch: None,
                pi_version: String::new(),
                refreshed_at_ms: 0,
            },
            created_at_ms: now,
            last_opened_at_ms: 0,
        };
        // Catalog entries are cheap; creating directories or contacting remotes is not.
        storage::insert_project_if_missing(&db, &project)?;
    }
    storage::list_projects(&db)
}

fn default_workspace_key(connection_id: &str) -> String {
    if connection_id == "local" {
        "local".to_owned()
    } else {
        format!(
            "{:016x}",
            super::host_paths::fnv1a_64(connection_id.as_bytes())
        )
    }
}

pub(crate) async fn ready_with_paths(
    paths: &super::host_paths::HostPaths,
    servers: &ServerManager,
    events: &super::RuntimeEventBus,
    id: &str,
) -> Result<Project, String> {
    let mut project = storage::get_project(&storage::open_with_paths(paths)?, id)?
        .ok_or_else(|| format!("Project '{id}' was not found"))?;
    if project.default_workspace_pending() {
        let cwd: String = servers
            .request_typed(
                &project.connection,
                "workspace.ensure_default",
                serde_json::json!({
                    "key": default_workspace_key(&project.connection.id),
                    "development": cfg!(debug_assertions),
                }),
            )
            .await?;
        project.path = cwd.clone();
        project.metadata.cwd = cwd;
        project.metadata.refreshed_at_ms = storage::now_ms();
        storage::initialize_default_workspace(&storage::open_with_paths(paths)?, &project)?;
        events.send(RuntimeEventEnvelope::global(
            RuntimeEvent::ConfigurationChanged,
        ));
    }
    Ok(project)
}

pub(crate) async fn ready(
    app: &AppHandle,
    servers: &ServerManager,
    id: &str,
) -> Result<Project, String> {
    ready_with_paths(
        &super::host_paths::HostPaths::from_app(app)?,
        servers,
        app.state::<super::RuntimeEventBus>().inner(),
        id,
    )
    .await
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
    let current = ready(app, servers, id).await?;
    let default_workspace = current.is_default_workspace();
    let (connection, metadata) = inspect(servers, current.connection, current.path).await?;
    let normalized_path = metadata.cwd.clone();
    let project = Project {
        id: current.id,
        name: if default_workspace {
            current.name
        } else {
            Project::name_from_path(&normalized_path)
        },
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
    get(app, id)?;
    storage::touch_project(&storage::open(app)?, id, storage::now_ms())?;
    get(app, id)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<Vec<Project>, String> {
    if get(app, id)?.is_default_workspace() {
        return Err(
            "The default workspace cannot be removed; hide it in the connection menu".to_owned(),
        );
    }
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
    let default_id = Project::default_workspace_id(connection_id);
    let mut ordered = project_ids.to_vec();
    if !ordered.contains(&default_id) && storage::get_project(&db, &default_id)?.is_some() {
        ordered.insert(0, default_id);
    }
    storage::reorder_projects(&mut db, connection_id, &ordered)?;
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
