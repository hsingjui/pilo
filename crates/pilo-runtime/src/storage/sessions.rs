use std::collections::{HashMap, HashSet};

use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};

use pilo_domain::{SessionIndexEntry, SessionUiStateUpdate};

use super::now_ms;

pub(crate) fn insert_cli_session_alias(
    db: &SqliteConnection,
    project_id: &str,
    request_id: &str,
    pi_session_id: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO cli_session_aliases(project_id,request_id,pi_session_id) VALUES(?1,?2,?3)",
        params![project_id, request_id, pi_session_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub(crate) fn cli_session_alias(
    db: &SqliteConnection,
    project_id: &str,
    id: &str,
) -> Result<Option<(String, String)>, String> {
    db.query_row(
        "SELECT request_id,pi_session_id FROM cli_session_aliases
         WHERE project_id=?1 AND (request_id=?2 OR pi_session_id=?2)",
        params![project_id, id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn list_sessions(
    db: &SqliteConnection,
    project_id: &str,
) -> Result<Vec<SessionIndexEntry>, String> {
    let mut statement = db.prepare(
        "SELECT s.connection_id,s.project_id,s.pi_session_id,s.session_path,s.name,s.cwd,s.created_at,s.updated_at,s.message_count,s.last_message_at,s.first_user_message_preview,s.file_size,s.file_mtime_ns,s.last_offset,s.indexed_at_ms,
                COALESCE(u.pinned,0),u.title_override,u.archived_at_ms
         FROM sessions s LEFT JOIN session_ui_state u ON u.project_id=s.project_id AND u.session_path=s.session_path
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
                archived_at: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_session(
    db: &SqliteConnection,
    session_path: &str,
    project_id: Option<&str>,
) -> Result<Option<SessionIndexEntry>, String> {
    let inferred_project_id = if project_id.is_none() {
        let (count, owner): (i64, Option<String>) = db
            .query_row(
                "SELECT COUNT(*),MIN(project_id) FROM sessions WHERE session_path=?1",
                params![session_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        if count > 1 {
            return Err("session path is ambiguous; projectId is required".to_owned());
        }
        owner
    } else {
        None
    };
    let Some(project_id) = project_id.or(inferred_project_id.as_deref()) else {
        return Ok(None);
    };
    db.query_row(
        "SELECT s.connection_id,s.project_id,s.pi_session_id,s.session_path,s.name,s.cwd,s.created_at,s.updated_at,s.message_count,s.last_message_at,s.first_user_message_preview,s.file_size,s.file_mtime_ns,s.last_offset,s.indexed_at_ms,COALESCE(u.pinned,0),u.title_override,u.archived_at_ms
         FROM sessions s LEFT JOIN session_ui_state u ON u.project_id=s.project_id AND u.session_path=s.session_path WHERE s.project_id=?2 AND s.session_path=?1",
        params![session_path, project_id],
        |row| Ok(SessionIndexEntry { connection_id: row.get(0)?, project_id: row.get(1)?, pi_session_id: row.get(2)?, session_path: row.get(3)?, name: row.get(4)?, cwd: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, message_count: row.get::<_, i64>(8)? as u64, last_message_at: row.get(9)?, first_user_message_preview: row.get(10)?, file_size: row.get::<_, i64>(11)? as u64, file_mtime_ns: row.get::<_, i64>(12)? as u64, last_offset: row.get::<_, i64>(13)? as u64, indexed_at_ms: row.get::<_, i64>(14)? as u64, pinned: row.get::<_, i64>(15)? != 0, title_override: row.get(16)?, archived_at: row.get(17)? })
    ).optional().map_err(|error| error.to_string())
}

pub fn update_session_ui_state(
    db: &SqliteConnection,
    session_path: &str,
    update: &SessionUiStateUpdate,
    project_id: Option<&str>,
) -> Result<SessionIndexEntry, String> {
    let session = get_session(db, session_path, project_id)?
        .ok_or_else(|| format!("session '{session_path}' is not indexed"))?;

    let now = now_ms() as i64;
    let pinned = if update.archived == Some(true) {
        Some(false)
    } else {
        update.pinned
    };
    db.execute(
        "INSERT INTO session_ui_state(session_path,pinned,title_override,updated_at_ms,project_id,archived_at_ms)
         VALUES(?1,COALESCE(?2,0),?3,?4,?5,?6)
         ON CONFLICT(project_id,session_path) DO UPDATE SET
           pinned=COALESCE(?2,pinned),
           title_override=CASE WHEN ?7 THEN excluded.title_override ELSE title_override END,
           updated_at_ms=excluded.updated_at_ms,
           archived_at_ms=CASE WHEN ?8 THEN excluded.archived_at_ms ELSE archived_at_ms END",
        params![
            session_path,
            pinned,
            update.title_override.as_ref().and_then(|title| title.as_deref()),
            now,
            session.project_id,
            update.archived.filter(|archived| *archived).map(|_| now),
            update.title_override.is_some(),
            update.archived.is_some(),
        ],
    )
    .map_err(|error| error.to_string())?;

    get_session(db, session_path, Some(&session.project_id))?
        .ok_or_else(|| format!("session '{session_path}' disappeared"))
}

pub(crate) fn unarchive_session_if_archived(
    db: &SqliteConnection,
    project_id: &str,
    session_path: &str,
) -> Result<bool, String> {
    db.execute(
        "UPDATE session_ui_state SET archived_at_ms=NULL,updated_at_ms=?3
         WHERE project_id=?1 AND session_path=?2 AND archived_at_ms IS NOT NULL",
        params![project_id, session_path, now_ms() as i64],
    )
    .map(|changed| changed > 0)
    .map_err(|error| error.to_string())
}

pub fn upsert_session(db: &SqliteConnection, session: &SessionIndexEntry) -> Result<(), String> {
    db.execute(
        "INSERT INTO sessions(connection_id,project_id,pi_session_id,session_path,name,cwd,created_at,updated_at,message_count,last_message_at,first_user_message_preview,file_size,file_mtime_ns,last_offset,indexed_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(project_id,session_path) DO UPDATE SET connection_id=excluded.connection_id,project_id=excluded.project_id,pi_session_id=excluded.pi_session_id,name=excluded.name,cwd=excluded.cwd,created_at=excluded.created_at,updated_at=excluded.updated_at,message_count=excluded.message_count,last_message_at=excluded.last_message_at,first_user_message_preview=excluded.first_user_message_preview,file_size=excluded.file_size,file_mtime_ns=excluded.file_mtime_ns,last_offset=excluded.last_offset,indexed_at_ms=excluded.indexed_at_ms",
        params![session.connection_id,session.project_id,session.pi_session_id,session.session_path,session.name,session.cwd,session.created_at,session.updated_at,session.message_count as i64,session.last_message_at,session.first_user_message_preview,session.file_size as i64,session.file_mtime_ns as i64,session.last_offset as i64,session.indexed_at_ms as i64]
    ).map_err(|error| error.to_string())?;
    Ok(())
}

/// The file size and mtime at which each of the project's sessions was last
/// searched whole for a session name, by session path.
pub fn session_name_scans(
    db: &SqliteConnection,
    project_id: &str,
) -> Result<HashMap<String, (u64, u64)>, String> {
    let mut statement = db
        .prepare(
            "SELECT session_path,name_scanned_size,name_scanned_mtime_ns FROM sessions
             WHERE project_id=?1 AND name_scanned_size IS NOT NULL AND name_scanned_mtime_ns IS NOT NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64),
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

/// Records the fingerprint of a whole-file session name search, or clears it.
pub fn set_session_name_scan(
    db: &SqliteConnection,
    project_id: &str,
    session_path: &str,
    scanned: Option<(u64, u64)>,
) -> Result<(), String> {
    let (size, mtime_ns) = scanned.map_or((None, None), |(size, mtime_ns)| {
        (Some(size as i64), Some(mtime_ns as i64))
    });
    db.execute(
        "UPDATE sessions SET name_scanned_size=?3,name_scanned_mtime_ns=?4
         WHERE project_id=?1 AND session_path=?2",
        params![project_id, session_path, size, mtime_ns],
    )
    .map_err(|error| error.to_string())?;
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
            "DELETE FROM session_read_state WHERE project_id=?1 AND session_path=?2",
            params![project_id, session_path],
        )
        .map_err(|error| error.to_string())?;
        db.execute(
            "DELETE FROM session_ui_state WHERE project_id=?1 AND session_path=?2",
            params![project_id, session_path],
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
    let mut statement = db
        .prepare("SELECT session_path FROM sessions WHERE project_id=?1")
        .map_err(|error| error.to_string())?;
    let existing = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let paths = paths.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut removed = 0;
    for session_path in existing {
        if !paths.contains(session_path.as_str()) {
            removed += db
                .execute(
                    "DELETE FROM sessions WHERE project_id=?1 AND session_path=?2",
                    params![project_id, session_path],
                )
                .map_err(|error| error.to_string())? as u64;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_archive_preserves_title_and_is_scoped_to_project() {
        let db = SqliteConnection::open_in_memory().unwrap();
        super::super::schema::initialize_schema(&db).unwrap();
        db.execute_batch(
            "ALTER TABLE session_ui_state DROP COLUMN archived_at_ms;
             INSERT INTO connections(id,name,kind_json,updated_at_ms)
               VALUES('local','Local','{\"type\":\"local\"}',0);
             INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
               VALUES('first','local','First','/first','{}',0,0),
                     ('second','local','Second','/second','{}',0,0);
             INSERT INTO sessions(session_path,connection_id,project_id,pi_session_id,cwd,created_at,updated_at,message_count,file_size,file_mtime_ns,last_offset,indexed_at_ms)
               VALUES('/s.jsonl','local','first','s','/first','','',0,0,0,0,0),
                     ('/s.jsonl','local','second','s','/second','','',0,0,0,0,0),
                     ('/empty.jsonl','local','first','empty','/first','','',0,0,0,0,0);
             INSERT INTO session_ui_state(project_id,session_path,pinned,title_override,updated_at_ms)
               VALUES('first','/s.jsonl',1,'Title',0),('second','/s.jsonl',1,'Other title',0);",
        )
        .unwrap();
        for _ in 0..2 {
            super::super::schema::initialize_schema(&db).unwrap();
        }
        let read = |project| {
            get_session(&db, "/s.jsonl", Some(project))
                .unwrap()
                .unwrap()
        };
        let write = |archived| {
            update_session_ui_state(
                &db,
                "/s.jsonl",
                &SessionUiStateUpdate {
                    archived: Some(archived),
                    ..Default::default()
                },
                Some("first"),
            )
            .unwrap()
        };
        let initial = read("first");
        assert_eq!(initial.archived_at, None);
        assert!(initial.pinned);
        assert_eq!(initial.title_override.as_deref(), Some("Title"));

        let archived = write(true);
        assert!(archived.archived_at.is_some_and(|time| time > 0));
        assert!(!archived.pinned);
        assert_eq!(archived.title_override, initial.title_override);
        assert!(read("second").pinned);
        assert_eq!(read("second").archived_at, None);
        assert_eq!(
            list_sessions(&db, "first")
                .unwrap()
                .into_iter()
                .find(|entry| entry.session_path == "/s.jsonl"),
            Some(archived.clone())
        );

        let renamed = update_session_ui_state(
            &db,
            "/s.jsonl",
            &serde_json::from_value(serde_json::json!({ "titleOverride": null })).unwrap(),
            Some("first"),
        )
        .unwrap();
        assert_eq!(renamed.archived_at, archived.archived_at);
        assert_eq!(renamed.title_override, None);

        let restored = write(false);
        assert_eq!(restored.archived_at, None);
        assert!(!restored.pinned);
        assert_eq!(restored, read("first"));
        let archive = serde_json::from_value(serde_json::json!({ "archived": true })).unwrap();
        let no_preferences =
            update_session_ui_state(&db, "/empty.jsonl", &archive, Some("first")).unwrap();
        assert!(no_preferences.archived_at.is_some());
        assert_eq!(no_preferences.title_override, None);
        assert!(update_session_ui_state(&db, "/invalid.jsonl", &archive, Some("first")).is_err());
    }
}
