use std::collections::HashSet;

use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};

use crate::domain::{
    Connection, PiRuntime, Project, ProjectMetadata, ProjectModelCache, ProjectModelScope,
    ProjectScopedModel,
};

pub fn upsert_project(db: &SqliteConnection, project: &Project) -> Result<(), String> {
    let metadata_json =
        serde_json::to_string(&project.metadata).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms,sort_order)
         VALUES(?1,?2,?3,?4,?5,?6,?7,COALESCE((SELECT MAX(sort_order)+1 FROM projects WHERE connection_id=?2),0))
         ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id,name=excluded.name,path=excluded.path,metadata_json=excluded.metadata_json,last_opened_at_ms=excluded.last_opened_at_ms",
        params![project.id, project.connection.id, project.name, project.path, metadata_json, project.created_at_ms as i64, project.last_opened_at_ms as i64],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    let metadata_json: String = row.get(3)?;
    let kind_json: String = row.get(8)?;
    let pi_runtime_value: String = row.get(10)?;
    let pi_runtime = PiRuntime::parse(&pi_runtime_value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            10,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    let metadata = serde_json::from_str::<ProjectMetadata>(&metadata_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let kind = serde_json::from_str(&kind_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        metadata,
        created_at_ms: row.get::<_, i64>(4)? as u64,
        last_opened_at_ms: row.get::<_, i64>(5)? as u64,
        connection: Connection {
            id: row.get(6)?,
            name: row.get(7)?,
            pi_executable: row.get(9)?,
            pi_runtime,
            kind,
            shown_in_home: row.get::<_, i64>(11)? != 0,
        },
    })
}

pub fn list_projects(db: &SqliteConnection) -> Result<Vec<Project>, String> {
    let mut statement = db.prepare(
        "SELECT p.id,p.name,p.path,p.metadata_json,p.created_at_ms,p.last_opened_at_ms,c.id,c.name,c.kind_json,c.pi_executable,c.pi_runtime,c.shown_in_home
         FROM projects p JOIN connections c ON c.id=p.connection_id
         ORDER BY p.connection_id ASC,p.sort_order ASC,p.name ASC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], project_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn reorder_projects(
    db: &mut SqliteConnection,
    connection_id: &str,
    project_ids: &[String],
) -> Result<(), String> {
    let existing = {
        let mut statement = db
            .prepare("SELECT id FROM projects WHERE connection_id=?1")
            .map_err(|error| error.to_string())?;
        statement
            .query_map(params![connection_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let existing_ids = existing.iter().collect::<HashSet<_>>();
    let requested_ids = project_ids.iter().collect::<HashSet<_>>();
    if existing.len() != project_ids.len()
        || requested_ids.len() != project_ids.len()
        || existing_ids != requested_ids
    {
        return Err(format!(
            "Project order for connection '{connection_id}' does not match the current project set"
        ));
    }

    let transaction = db.transaction().map_err(|error| error.to_string())?;
    for (index, project_id) in project_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE projects SET sort_order=?1 WHERE id=?2 AND connection_id=?3",
                params![index as i64, project_id, connection_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_project(db: &SqliteConnection, id: &str) -> Result<Option<Project>, String> {
    db.query_row(
        "SELECT p.id,p.name,p.path,p.metadata_json,p.created_at_ms,p.last_opened_at_ms,c.id,c.name,c.kind_json,c.pi_executable,c.pi_runtime,c.shown_in_home
         FROM projects p JOIN connections c ON c.id=p.connection_id WHERE p.id=?1",
        params![id],
        project_from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn list_project_model_cache(db: &SqliteConnection) -> Result<Vec<ProjectModelCache>, String> {
    let mut statement = db
        .prepare(
            "SELECT project_id,models_json,default_model_json,default_thinking_level,refreshed_at_ms,commands_json FROM project_model_cache ORDER BY refreshed_at_ms DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let models_json: String = row.get(1)?;
            let models = serde_json::from_str(&models_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let default_model_json: Option<String> = row.get(2)?;
            let default_model = default_model_json
                .map(|json| {
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?;
            let commands_json: Option<String> = row.get(5)?;
            let commands = commands_json
                .map(|json| {
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?;
            Ok(ProjectModelCache {
                project_id: row.get(0)?,
                models,
                commands,
                default_model,
                default_thinking_level: row.get(3)?,
                refreshed_at_ms: row.get::<_, i64>(4)? as u64,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn upsert_project_model_cache(
    db: &SqliteConnection,
    cache: &ProjectModelCache,
) -> Result<(), String> {
    let models_json = serde_json::to_string(&cache.models).map_err(|error| error.to_string())?;
    let commands_json = cache
        .commands
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    let default_model_json = cache
        .default_model
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO project_model_cache(project_id,models_json,default_model_json,default_thinking_level,refreshed_at_ms,commands_json) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(project_id) DO UPDATE SET models_json=excluded.models_json, default_model_json=excluded.default_model_json, default_thinking_level=excluded.default_thinking_level, refreshed_at_ms=excluded.refreshed_at_ms, commands_json=COALESCE(excluded.commands_json,project_model_cache.commands_json)
         WHERE excluded.refreshed_at_ms >= project_model_cache.refreshed_at_ms",
        params![
            cache.project_id,
            models_json,
            default_model_json,
            cache.default_thinking_level,
            cache.refreshed_at_ms as i64,
            commands_json
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_project_model_scope(
    db: &SqliteConnection,
    project_id: &str,
) -> Result<ProjectModelScope, String> {
    if get_project(db, project_id)?.is_none() {
        return Err(format!("Project '{project_id}' was not found"));
    }
    let stored = db
        .query_row(
            "SELECT models_json,updated_at_ms FROM project_model_scopes WHERE project_id=?1",
            params![project_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (models_json, updated_at_ms) = stored.unwrap_or((None, 0));
    Ok(ProjectModelScope {
        project_id: project_id.to_owned(),
        models: models_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| format!("failed to read project model scope: {error}"))?,
        updated_at_ms: updated_at_ms as u64,
    })
}

pub fn set_project_model_scope(
    db: &SqliteConnection,
    project_id: &str,
    models: Option<Vec<ProjectScopedModel>>,
) -> Result<ProjectModelScope, String> {
    if get_project(db, project_id)?.is_none() {
        return Err(format!("Project '{project_id}' was not found"));
    }
    let mut identities = HashSet::new();
    for model in models.iter().flatten() {
        if model.provider.trim().is_empty() || model.model_id.trim().is_empty() {
            return Err("model scope provider and model id cannot be empty".to_owned());
        }
        if !identities.insert((&model.provider, &model.model_id)) {
            return Err("model scope contains duplicate model identities".to_owned());
        }
    }
    if models
        .iter()
        .flatten()
        .filter(|model| model.is_default)
        .count()
        > 1
    {
        return Err("model scope can contain only one default model".to_owned());
    }
    let models_json = models
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    // Monotonic per-project revisions also disambiguate concurrent saves in one millisecond.
    let updated_at_ms = db.query_row(
        "INSERT INTO project_model_scopes(project_id,models_json,updated_at_ms) VALUES(?1,?2,?3)
         ON CONFLICT(project_id) DO UPDATE SET models_json=excluded.models_json, updated_at_ms=MAX(excluded.updated_at_ms,project_model_scopes.updated_at_ms+1)
         RETURNING updated_at_ms",
        params![project_id, models_json, super::now_ms() as i64],
        |row| row.get::<_, i64>(0),
    ).map_err(|error| format!("failed to save project model scope: {error}"))?;
    Ok(ProjectModelScope {
        project_id: project_id.to_owned(),
        models,
        updated_at_ms: updated_at_ms as u64,
    })
}

pub fn remove_project(db: &SqliteConnection, id: &str) -> Result<bool, String> {
    Ok(db
        .execute("DELETE FROM projects WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?
        > 0)
}
