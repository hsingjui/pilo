use std::collections::HashSet;

use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};

use crate::domain::{SessionIndexEntry, SessionUiStateUpdate};

use super::now_ms;

pub fn list_sessions(
    db: &SqliteConnection,
    project_id: &str,
) -> Result<Vec<SessionIndexEntry>, String> {
    let mut statement = db.prepare(
        "SELECT s.connection_id,s.project_id,s.pi_session_id,s.session_path,s.name,s.cwd,s.created_at,s.updated_at,s.message_count,s.last_message_at,s.first_user_message_preview,s.file_size,s.file_mtime_ns,s.last_offset,s.indexed_at_ms,
                COALESCE(u.pinned,0),u.title_override
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
                title_override: row.get(16)?,
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
        "SELECT s.connection_id,s.project_id,s.pi_session_id,s.session_path,s.name,s.cwd,s.created_at,s.updated_at,s.message_count,s.last_message_at,s.first_user_message_preview,s.file_size,s.file_mtime_ns,s.last_offset,s.indexed_at_ms,COALESCE(u.pinned,0),u.title_override
         FROM sessions s LEFT JOIN session_ui_state u ON u.session_path=s.session_path WHERE s.session_path=?1",
        params![session_path],
        |row| Ok(SessionIndexEntry { connection_id: row.get(0)?, project_id: row.get(1)?, pi_session_id: row.get(2)?, session_path: row.get(3)?, name: row.get(4)?, cwd: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, message_count: row.get::<_, i64>(8)? as u64, last_message_at: row.get(9)?, first_user_message_preview: row.get(10)?, file_size: row.get::<_, i64>(11)? as u64, file_mtime_ns: row.get::<_, i64>(12)? as u64, last_offset: row.get::<_, i64>(13)? as u64, indexed_at_ms: row.get::<_, i64>(14)? as u64, pinned: row.get::<_, i64>(15)? != 0, title_override: row.get(16)? })
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
        "INSERT INTO session_ui_state(session_path,pinned,title_override,updated_at_ms)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(session_path) DO UPDATE SET pinned=excluded.pinned,title_override=excluded.title_override,updated_at_ms=excluded.updated_at_ms",
        params![
            session_path,
            i64::from(update.pinned),
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

pub fn remove_session_for_project(
    db: &SqliteConnection,
    project_id: &str,
    session_path: &str,
) -> Result<bool, String> {
    let removed = db
        .execute(
            "DELETE FROM sessions WHERE project_id=?1 AND session_path=?2",
            params![project_id, session_path],
        )
        .map_err(|error| error.to_string())?
        > 0;
    if removed {
        db.execute(
            "DELETE FROM session_ui_state WHERE session_path=?1",
            params![session_path],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(removed)
}

pub fn remove_missing_sessions(
    db: &SqliteConnection,
    project_id: &str,
    paths: &[String],
) -> Result<u64, String> {
    let existing = list_sessions(db, project_id)?;
    let paths = paths.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut removed = 0;
    for session in existing {
        if !paths.contains(session.session_path.as_str()) {
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
