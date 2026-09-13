use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};
use tauri::{AppHandle, Manager};

use crate::domain::{
    Connection, Project, ProjectMetadata, SessionIndexEntry, SessionUiStateUpdate,
};

const DB_FILE_NAME: &str = "pilo.sqlite3";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
    Ok(dir)
}

pub fn open(app: &AppHandle) -> Result<SqliteConnection, String> {
    let dir = app_data_dir(app)?;
    let connection = SqliteConnection::open(dir.join(DB_FILE_NAME))
        .map_err(|error| format!("failed to open Pilo SQLite index: {error}"))?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn initialize_schema(db: &SqliteConnection) -> Result<(), String> {
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS connections (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           kind_json TEXT NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS projects (
           id TEXT PRIMARY KEY,
           connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           path TEXT NOT NULL,
           metadata_json TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           last_opened_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_projects_recent ON projects(last_opened_at_ms DESC);
         CREATE TABLE IF NOT EXISTS sessions (
           session_path TEXT PRIMARY KEY,
           connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
           project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
           pi_session_id TEXT NOT NULL,
           name TEXT,
           cwd TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           message_count INTEGER NOT NULL,
           last_message_at TEXT,
           first_user_message_preview TEXT,
           file_size INTEGER NOT NULL,
           file_mtime_ns INTEGER NOT NULL,
           last_offset INTEGER NOT NULL,
           indexed_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_project_mtime ON sessions(project_id, file_mtime_ns DESC);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_project_pi_id ON sessions(project_id, pi_session_id);
         CREATE TABLE IF NOT EXISTS session_ui_state (
           session_path TEXT PRIMARY KEY,
           pinned INTEGER NOT NULL DEFAULT 0,
           archived INTEGER NOT NULL DEFAULT 0,
           title_override TEXT,
           updated_at_ms INTEGER NOT NULL
         );",
    )
    .map_err(|error| format!("failed to initialize Pilo SQLite schema: {error}"))?;
    Ok(())
}

pub fn upsert_connection(db: &SqliteConnection, connection: &Connection) -> Result<(), String> {
    let kind_json = serde_json::to_string(&connection.kind).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO connections(id,name,kind_json,updated_at_ms) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind_json=excluded.kind_json, updated_at_ms=excluded.updated_at_ms",
        params![connection.id, connection.name, kind_json, now_ms() as i64],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_connections(db: &SqliteConnection) -> Result<Vec<Connection>, String> {
    let mut statement = db
        .prepare("SELECT id,name,kind_json FROM connections ORDER BY name COLLATE NOCASE ASC")
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
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                kind,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_connection(db: &SqliteConnection, id: &str) -> Result<Option<Connection>, String> {
    db.query_row(
        "SELECT id,name,kind_json FROM connections WHERE id=?1",
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
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                kind,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
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
    Ok(db
        .execute("DELETE FROM connections WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?
        > 0)
}

pub fn upsert_project(db: &SqliteConnection, project: &Project) -> Result<(), String> {
    upsert_connection(db, &project.connection)?;
    let metadata_json =
        serde_json::to_string(&project.metadata).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id,name=excluded.name,path=excluded.path,metadata_json=excluded.metadata_json,last_opened_at_ms=excluded.last_opened_at_ms",
        params![project.id, project.connection.id, project.name, project.path, metadata_json, project.created_at_ms as i64, project.last_opened_at_ms as i64],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_projects(db: &SqliteConnection) -> Result<Vec<Project>, String> {
    let mut statement = db.prepare(
        "SELECT w.id,w.name,w.path,w.metadata_json,w.created_at_ms,w.last_opened_at_ms,c.id,c.name,c.kind_json
         FROM projects w JOIN connections c ON c.id=w.connection_id
         ORDER BY w.last_opened_at_ms DESC,w.name ASC"
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
                    kind,
                },
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_project(db: &SqliteConnection, id: &str) -> Result<Option<Project>, String> {
    Ok(list_projects(db)?
        .into_iter()
        .find(|project| project.id == id))
}

pub fn remove_project(db: &SqliteConnection, id: &str) -> Result<bool, String> {
    Ok(db
        .execute("DELETE FROM projects WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?
        > 0)
}

pub fn list_sessions(
    db: &SqliteConnection,
    project_id: &str,
) -> Result<Vec<SessionIndexEntry>, String> {
    let mut statement = db.prepare(
        "SELECT s.connection_id,s.project_id,s.pi_session_id,s.session_path,s.name,s.cwd,s.created_at,s.updated_at,s.message_count,s.last_message_at,s.first_user_message_preview,s.file_size,s.file_mtime_ns,s.last_offset,s.indexed_at_ms,
                COALESCE(u.pinned,0),COALESCE(u.archived,0),u.title_override
         FROM sessions s LEFT JOIN session_ui_state u ON u.session_path=s.session_path
         WHERE s.project_id=?1 ORDER BY s.file_mtime_ns DESC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(SessionIndexEntry {
                connection_id: row.get(0)?,
                project_id: row.get(1)?,
                pi_session_id: row.get(2)?,
                session_path: row.get(3)?,
                name: row.get(4)?,
                cwd: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                message_count: row.get::<_, i64>(8)? as u64,
                last_message_at: row.get(9)?,
                first_user_message_preview: row.get(10)?,
                file_size: row.get::<_, i64>(11)? as u64,
                file_mtime_ns: row.get::<_, i64>(12)? as u64,
                last_offset: row.get::<_, i64>(13)? as u64,
                indexed_at_ms: row.get::<_, i64>(14)? as u64,
                pinned: row.get::<_, i64>(15)? != 0,
                archived: row.get::<_, i64>(16)? != 0,
                title_override: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_session(
    db: &SqliteConnection,
    session_path: &str,
) -> Result<Option<SessionIndexEntry>, String> {
    db.query_row(
        "SELECT s.connection_id,s.project_id,s.pi_session_id,s.session_path,s.name,s.cwd,s.created_at,s.updated_at,s.message_count,s.last_message_at,s.first_user_message_preview,s.file_size,s.file_mtime_ns,s.last_offset,s.indexed_at_ms,COALESCE(u.pinned,0),COALESCE(u.archived,0),u.title_override
         FROM sessions s LEFT JOIN session_ui_state u ON u.session_path=s.session_path WHERE s.session_path=?1",
        params![session_path],
        |row| Ok(SessionIndexEntry { connection_id: row.get(0)?, project_id: row.get(1)?, pi_session_id: row.get(2)?, session_path: row.get(3)?, name: row.get(4)?, cwd: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, message_count: row.get::<_, i64>(8)? as u64, last_message_at: row.get(9)?, first_user_message_preview: row.get(10)?, file_size: row.get::<_, i64>(11)? as u64, file_mtime_ns: row.get::<_, i64>(12)? as u64, last_offset: row.get::<_, i64>(13)? as u64, indexed_at_ms: row.get::<_, i64>(14)? as u64, pinned: row.get::<_, i64>(15)? != 0, archived: row.get::<_, i64>(16)? != 0, title_override: row.get(17)? })
    ).optional().map_err(|error| error.to_string())
}

pub fn update_session_ui_state(
    db: &SqliteConnection,
    session_path: &str,
    update: &SessionUiStateUpdate,
) -> Result<SessionIndexEntry, String> {
    let exists = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_path=?1)",
            params![session_path],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    if !exists {
        return Err(format!("session '{session_path}' is not indexed"));
    }

    db.execute(
        "INSERT INTO session_ui_state(session_path,pinned,archived,title_override,updated_at_ms)
         VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(session_path) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived,title_override=excluded.title_override,updated_at_ms=excluded.updated_at_ms",
        params![
            session_path,
            i64::from(update.pinned),
            i64::from(update.archived),
            update.title_override,
            now_ms() as i64,
        ],
    )
    .map_err(|error| error.to_string())?;

    get_session(db, session_path)?.ok_or_else(|| format!("session '{session_path}' disappeared"))
}

pub fn upsert_session(db: &SqliteConnection, session: &SessionIndexEntry) -> Result<(), String> {
    db.execute(
        "INSERT INTO sessions(connection_id,project_id,pi_session_id,session_path,name,cwd,created_at,updated_at,message_count,last_message_at,first_user_message_preview,file_size,file_mtime_ns,last_offset,indexed_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(session_path) DO UPDATE SET connection_id=excluded.connection_id,project_id=excluded.project_id,pi_session_id=excluded.pi_session_id,name=excluded.name,cwd=excluded.cwd,created_at=excluded.created_at,updated_at=excluded.updated_at,message_count=excluded.message_count,last_message_at=excluded.last_message_at,first_user_message_preview=excluded.first_user_message_preview,file_size=excluded.file_size,file_mtime_ns=excluded.file_mtime_ns,last_offset=excluded.last_offset,indexed_at_ms=excluded.indexed_at_ms",
        params![session.connection_id,session.project_id,session.pi_session_id,session.session_path,session.name,session.cwd,session.created_at,session.updated_at,session.message_count as i64,session.last_message_at,session.first_user_message_preview,session.file_size as i64,session.file_mtime_ns as i64,session.last_offset as i64,session.indexed_at_ms as i64]
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_missing_sessions(
    db: &SqliteConnection,
    project_id: &str,
    paths: &[String],
) -> Result<u64, String> {
    let existing = list_sessions(db, project_id)?;
    let mut removed = 0;
    for session in existing {
        if !paths.iter().any(|path| path == &session.session_path) {
            removed += db
                .execute(
                    "DELETE FROM sessions WHERE session_path=?1",
                    params![session.session_path],
                )
                .map_err(|error| error.to_string())? as u64;
        }
    }
    Ok(removed)
}
