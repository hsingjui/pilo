use super::Runtime;
use pilo_protocol::EnvironmentInfo;

use pilo_domain::{Connection, Project, ProjectMetadata};

use super::{
    events::{RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope},
    storage,
};

use super::{pi_workspace, server_client::ServerManager};

pub(crate) fn load_model_scope(
    runtime: &Runtime,
    project_id: &str,
) -> Result<pilo_domain::ProjectModelScope, String> {
    storage::get_project_model_scope(&storage::open(&runtime.paths)?, project_id)
}

pub(crate) fn save_model_scope(
    runtime: &Runtime,
    events: &RuntimeEventBus,
    project_id: &str,
    models: Option<Vec<pilo_domain::ProjectScopedModel>>,
) -> Result<pilo_domain::ProjectModelScope, String> {
    let scope =
        storage::set_project_model_scope(&storage::open(&runtime.paths)?, project_id, models)?;
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

pub fn list(runtime: &Runtime) -> Result<Vec<Project>, String> {
    let db = storage::open(&runtime.paths)?;
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
    runtime: &Runtime,
    servers: &ServerManager,
    id: &str,
) -> Result<Project, String> {
    ready_with_paths(&runtime.paths, servers, &runtime.events, id).await
}

pub(crate) fn get(runtime: &Runtime, id: &str) -> Result<Project, String> {
    storage::get_project(&storage::open(&runtime.paths)?, id)?
        .ok_or_else(|| format!("Project '{id}' was not found"))
}

pub(crate) async fn add(
    runtime: &Runtime,
    servers: &ServerManager,
    connection_id: String,
    path: String,
) -> Result<Project, String> {
    let connection = resolve_connection(runtime, &connection_id)?;
    let (connection, metadata) = inspect(servers, connection, path).await?;
    let normalized_path = metadata.cwd.clone();
    let id = Project::stable_id(&connection.id, &normalized_path);
    let db = storage::open(&runtime.paths)?;
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

pub(crate) fn touch(runtime: &Runtime, id: &str) -> Result<Project, String> {
    get(runtime, id)?;
    storage::touch_project(&storage::open(&runtime.paths)?, id, storage::now_ms())?;
    get(runtime, id)
}

pub(crate) fn remove(runtime: &Runtime, id: &str) -> Result<Vec<Project>, String> {
    if get(runtime, id)?.is_default_workspace() {
        return Err(
            "The default workspace cannot be removed; hide it in the connection menu".to_owned(),
        );
    }
    let db = storage::open(&runtime.paths)?;
    if !storage::remove_project(&db, id)? {
        return Err(format!("Project '{id}' was not found"));
    }
    pi_workspace::remove_session_anchor(&runtime.paths, id)?;
    storage::list_projects(&db)
}

pub(crate) fn reorder(
    runtime: &Runtime,
    connection_id: &str,
    project_ids: &[String],
) -> Result<Vec<Project>, String> {
    let mut db = storage::open(&runtime.paths)?;
    let default_id = Project::default_workspace_id(connection_id);
    let mut ordered = project_ids.to_vec();
    if !ordered.contains(&default_id) && storage::get_project(&db, &default_id)?.is_some() {
        ordered.insert(0, default_id);
    }
    storage::reorder_projects(&mut db, connection_id, &ordered)?;
    storage::list_projects(&db)
}

pub(crate) fn resolve_connection(
    runtime: &Runtime,
    connection_id: &str,
) -> Result<Connection, String> {
    let db = storage::open(&runtime.paths)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_project_catalog_and_scope_work_without_a_shell() {
        let root =
            std::env::temp_dir().join(format!("pilo-runtime-projects-{}", std::process::id()));
        let runtime = Runtime::new(
            super::super::host_paths::HostPaths::new(root.clone(), root.join("resources")).unwrap(),
            std::sync::Arc::new(super::super::host_events::RecordingEvents::default()),
        );
        let projects = super::super::project_api::project_list(&runtime).unwrap();
        assert_eq!(projects.len(), 1);
        let id = projects[0].id.clone();
        assert!(get(&runtime, "missing").is_err());
        assert_eq!(get(&runtime, &id).unwrap().id, id);
        assert!(
            super::super::project_api::project_model_cache_list(&runtime)
                .unwrap()
                .is_empty()
        );
        let scope = super::super::project_api::project_model_scope_set(
            &runtime,
            id.clone(),
            Some(Vec::new()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(
                super::super::project_api::project_model_scope_get(&runtime, id.clone()).unwrap()
            )
            .unwrap(),
            serde_json::to_value(scope).unwrap()
        );
        assert_eq!(
            super::super::project_api::project_touch(&runtime, id.clone())
                .unwrap()
                .id,
            id
        );
        assert_eq!(
            super::super::project_api::project_reorder(&runtime, "local".into(), vec![id])
                .unwrap()
                .len(),
            1
        );
        assert!(runtime.shell().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
