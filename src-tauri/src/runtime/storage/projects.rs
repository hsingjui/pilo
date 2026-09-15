use std::collections::HashSet;

use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};

use crate::domain::{Connection, Project, ProjectMetadata, ProjectModelCache};

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

pub fn list_projects(db: &SqliteConnection) -> Result<Vec<Project>, String> {
    let mut statement = db.prepare(
        "SELECT p.id,p.name,p.path,p.metadata_json,p.created_at_ms,p.last_opened_at_ms,c.id,c.name,c.kind_json,c.pi_executable
         FROM projects p JOIN connections c ON c.id=p.connection_id
         ORDER BY p.connection_id ASC,p.sort_order ASC,p.name ASC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let kind_json: String = row.get(8)?;
            let metadata_json: String = row.get(3)?;
            let kind = serde_json::from_str(&kind_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let metadata: ProjectMetadata =
                serde_json::from_str(&metadata_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
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
                    kind,
                },
            })
        })
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
        "SELECT p.id,p.name,p.path,p.metadata_json,p.created_at_ms,p.last_opened_at_ms,c.id,c.name,c.kind_json,c.pi_executable
         FROM projects p JOIN connections c ON c.id=p.connection_id WHERE p.id=?1",
        params![id],
        |row| {
            let kind_json: String = row.get(8)?;
            let metadata_json: String = row.get(3)?;
            let kind = serde_json::from_str(&kind_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let metadata: ProjectMetadata = serde_json::from_str(&metadata_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
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
                    kind,
                },
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn list_project_model_cache(db: &SqliteConnection) -> Result<Vec<ProjectModelCache>, String> {
    let mut statement = db
        .prepare(
            "SELECT project_id,models_json,default_model_json,default_thinking_level,refreshed_at_ms FROM project_model_cache ORDER BY refreshed_at_ms DESC",
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
            Ok(ProjectModelCache {
                project_id: row.get(0)?,
                models,
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
    let default_model_json = cache
        .default_model
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO project_model_cache(project_id,models_json,default_model_json,default_thinking_level,refreshed_at_ms) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(project_id) DO UPDATE SET models_json=excluded.models_json, default_model_json=excluded.default_model_json, default_thinking_level=excluded.default_thinking_level, refreshed_at_ms=excluded.refreshed_at_ms
         WHERE excluded.refreshed_at_ms >= project_model_cache.refreshed_at_ms",
        params![
            cache.project_id,
            models_json,
            default_model_json,
            cache.default_thinking_level,
            cache.refreshed_at_ms as i64
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_project(db: &SqliteConnection, id: &str) -> Result<bool, String> {
    Ok(db
        .execute("DELETE FROM projects WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?
        > 0)
}
