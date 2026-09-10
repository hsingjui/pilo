use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection as SqliteConnection, OptionalExtension};
use tauri::{AppHandle, Manager};

use crate::domain::{Connection, SessionIndexEntry, Workspace, WorkspaceMetadata};

const DB_FILE_NAME: &str = "pilo.sqlite3";
const LEGACY_WORKSPACES_FILE_NAME: &str = "workspaces.json";

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
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS connections (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               kind_json TEXT NOT NULL,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS workspaces (
               id TEXT PRIMARY KEY,
               connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               path TEXT NOT NULL,
               metadata_json TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL,
               last_opened_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_workspaces_recent ON workspaces(last_opened_at_ms DESC);
             CREATE TABLE IF NOT EXISTS sessions (
               session_path TEXT PRIMARY KEY,
               connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
               workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
             CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated ON sessions(workspace_id, updated_at DESC);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_workspace_pi_id ON sessions(workspace_id, pi_session_id);",
        )
        .map_err(|error| format!("failed to initialize Pilo SQLite schema: {error}"))?;
    migrate_legacy_workspaces(&connection, &dir)?;
    Ok(connection)
}

fn migrate_legacy_workspaces(
    db: &SqliteConnection,
    app_data_dir: &std::path::Path,
) -> Result<(), String> {
    let workspace_count: i64 = db
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if workspace_count != 0 {
        return Ok(());
    }

    let legacy_path = app_data_dir.join(LEGACY_WORKSPACES_FILE_NAME);
    if !legacy_path.exists() {
        return Ok(());
    }

    let text = fs::read_to_string(&legacy_path).map_err(|error| {
        format!(
            "failed to read legacy Workspace store '{}': {error}",
            legacy_path.display()
        )
    })?;
    let workspaces: Vec<Workspace> = serde_json::from_str(&text).map_err(|error| {
        format!(
            "failed to parse legacy Workspace store '{}': {error}",
            legacy_path.display()
        )
    })?;
    for workspace in &workspaces {
        upsert_workspace(db, workspace)?;
    }
    fs::remove_file(&legacy_path).map_err(|error| {
        format!(
            "migrated Workspace data to SQLite but failed to remove legacy store '{}': {error}",
            legacy_path.display()
        )
    })?;
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

pub fn upsert_workspace(db: &SqliteConnection, workspace: &Workspace) -> Result<(), String> {
    upsert_connection(db, &workspace.connection)?;
    let metadata_json =
        serde_json::to_string(&workspace.metadata).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO workspaces(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id,name=excluded.name,path=excluded.path,metadata_json=excluded.metadata_json,last_opened_at_ms=excluded.last_opened_at_ms",
        params![workspace.id, workspace.connection.id, workspace.name, workspace.path, metadata_json, workspace.created_at_ms as i64, workspace.last_opened_at_ms as i64],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_workspaces(db: &SqliteConnection) -> Result<Vec<Workspace>, String> {
    let mut statement = db.prepare(
        "SELECT w.id,w.name,w.path,w.metadata_json,w.created_at_ms,w.last_opened_at_ms,c.id,c.name,c.kind_json
         FROM workspaces w JOIN connections c ON c.id=w.connection_id
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
            let metadata: WorkspaceMetadata =
                serde_json::from_str(&metadata_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(Workspace {
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

pub fn get_workspace(db: &SqliteConnection, id: &str) -> Result<Option<Workspace>, String> {
    Ok(list_workspaces(db)?
        .into_iter()
        .find(|workspace| workspace.id == id))
}

pub fn remove_workspace(db: &SqliteConnection, id: &str) -> Result<bool, String> {
    Ok(db
        .execute("DELETE FROM workspaces WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?
        > 0)
}

pub fn list_sessions(
    db: &SqliteConnection,
    workspace_id: &str,
) -> Result<Vec<SessionIndexEntry>, String> {
    let mut statement = db.prepare(
        "SELECT connection_id,workspace_id,pi_session_id,session_path,name,cwd,created_at,updated_at,message_count,last_message_at,first_user_message_preview,file_size,file_mtime_ns,last_offset,indexed_at_ms
         FROM sessions WHERE workspace_id=?1 ORDER BY updated_at DESC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![workspace_id], |row| {
            Ok(SessionIndexEntry {
                connection_id: row.get(0)?,
                workspace_id: row.get(1)?,
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
        "SELECT connection_id,workspace_id,pi_session_id,session_path,name,cwd,created_at,updated_at,message_count,last_message_at,first_user_message_preview,file_size,file_mtime_ns,last_offset,indexed_at_ms FROM sessions WHERE session_path=?1",
        params![session_path],
        |row| Ok(SessionIndexEntry { connection_id: row.get(0)?, workspace_id: row.get(1)?, pi_session_id: row.get(2)?, session_path: row.get(3)?, name: row.get(4)?, cwd: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, message_count: row.get::<_, i64>(8)? as u64, last_message_at: row.get(9)?, first_user_message_preview: row.get(10)?, file_size: row.get::<_, i64>(11)? as u64, file_mtime_ns: row.get::<_, i64>(12)? as u64, last_offset: row.get::<_, i64>(13)? as u64, indexed_at_ms: row.get::<_, i64>(14)? as u64 })
    ).optional().map_err(|error| error.to_string())
}

pub fn upsert_session(db: &SqliteConnection, session: &SessionIndexEntry) -> Result<(), String> {
    db.execute(
        "INSERT INTO sessions(connection_id,workspace_id,pi_session_id,session_path,name,cwd,created_at,updated_at,message_count,last_message_at,first_user_message_preview,file_size,file_mtime_ns,last_offset,indexed_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(session_path) DO UPDATE SET connection_id=excluded.connection_id,workspace_id=excluded.workspace_id,pi_session_id=excluded.pi_session_id,name=excluded.name,cwd=excluded.cwd,created_at=excluded.created_at,updated_at=excluded.updated_at,message_count=excluded.message_count,last_message_at=excluded.last_message_at,first_user_message_preview=excluded.first_user_message_preview,file_size=excluded.file_size,file_mtime_ns=excluded.file_mtime_ns,last_offset=excluded.last_offset,indexed_at_ms=excluded.indexed_at_ms",
        params![session.connection_id,session.workspace_id,session.pi_session_id,session.session_path,session.name,session.cwd,session.created_at,session.updated_at,session.message_count as i64,session.last_message_at,session.first_user_message_preview,session.file_size as i64,session.file_mtime_ns as i64,session.last_offset as i64,session.indexed_at_ms as i64]
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_missing_sessions(
    db: &SqliteConnection,
    workspace_id: &str,
    paths: &[String],
) -> Result<u64, String> {
    let existing = list_sessions(db, workspace_id)?;
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
