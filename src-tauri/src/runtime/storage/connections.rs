use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};

use crate::domain::{Connection, ConnectionKind, ConnectionNamingModel, PiRuntime};

use super::now_ms;

pub fn list_connection_naming_models(
    db: &SqliteConnection,
) -> Result<Vec<ConnectionNamingModel>, String> {
    let mut statement = db
        .prepare(
            "SELECT connection_id,provider,model_id FROM connection_naming_models ORDER BY connection_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(ConnectionNamingModel {
                connection_id: row.get(0)?,
                provider: row.get(1)?,
                model_id: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_connection_naming_model(
    db: &SqliteConnection,
    connection_id: &str,
) -> Result<Option<ConnectionNamingModel>, String> {
    db.query_row(
        "SELECT connection_id,provider,model_id FROM connection_naming_models WHERE connection_id=?1",
        params![connection_id],
        |row| {
            Ok(ConnectionNamingModel {
                connection_id: row.get(0)?,
                provider: row.get(1)?,
                model_id: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn upsert_connection_naming_model(
    db: &SqliteConnection,
    model: &ConnectionNamingModel,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO connection_naming_models(connection_id,provider,model_id,updated_at_ms) VALUES(?1,?2,?3,?4)
         ON CONFLICT(connection_id) DO UPDATE SET provider=excluded.provider, model_id=excluded.model_id, updated_at_ms=excluded.updated_at_ms",
        params![
            model.connection_id,
            model.provider,
            model.model_id,
            now_ms() as i64
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clear_connection_naming_model(
    db: &SqliteConnection,
    connection_id: &str,
) -> Result<(), String> {
    db.execute(
        "DELETE FROM connection_naming_models WHERE connection_id=?1",
        params![connection_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn upsert_connection(db: &SqliteConnection, connection: &Connection) -> Result<(), String> {
    let kind_json = serde_json::to_string(&connection.kind).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO connections(id,name,kind_json,pi_executable,pi_runtime,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind_json=excluded.kind_json, pi_executable=excluded.pi_executable, pi_runtime=excluded.pi_runtime, updated_at_ms=excluded.updated_at_ms",
        params![
            connection.id,
            connection.name,
            kind_json,
            connection.pi_executable,
            connection.pi_runtime.as_str(),
            now_ms() as i64
        ],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_connections(db: &SqliteConnection) -> Result<Vec<Connection>, String> {
    let mut statement = db
        .prepare("SELECT id,name,kind_json,pi_executable,pi_runtime FROM connections ORDER BY name COLLATE NOCASE ASC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let kind_json: String = row.get(2)?;
            let kind = serde_json::from_str(&kind_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let pi_runtime = parse_pi_runtime(row, 4)?;
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                pi_executable: row.get(3)?,
                pi_runtime,
                kind,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn parse_pi_runtime(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<PiRuntime> {
    let value: String = row.get(index)?;
    PiRuntime::parse(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })
}

pub fn get_connection(db: &SqliteConnection, id: &str) -> Result<Option<Connection>, String> {
    db.query_row(
        "SELECT id,name,kind_json,pi_executable,pi_runtime FROM connections WHERE id=?1",
        params![id],
        |row| {
            let kind_json: String = row.get(2)?;
            let kind = serde_json::from_str(&kind_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let pi_runtime = parse_pi_runtime(row, 4)?;
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                pi_executable: row.get(3)?,
                pi_runtime,
                kind,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn ensure_local_connection(db: &SqliteConnection) -> Result<Connection, String> {
    if let Some(connection) = get_connection(db, "local")? {
        return Ok(connection);
    }
    let connection = Connection {
        id: "local".to_owned(),
        name: "本地".to_owned(),
        pi_executable: None,
        pi_runtime: PiRuntime::default(),
        kind: ConnectionKind::Local,
    };
    upsert_connection(db, &connection)?;
    Ok(connection)
}

pub fn connection_project_count(db: &SqliteConnection, id: &str) -> Result<u64, String> {
    db.query_row(
        "SELECT COUNT(*) FROM projects WHERE connection_id=?1",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as u64)
    .map_err(|error| error.to_string())
}

pub fn remove_connection(db: &SqliteConnection, id: &str) -> Result<bool, String> {
    clear_connection_naming_model(db, id)?;
    Ok(db
        .execute("DELETE FROM connections WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?
        > 0)
}
