use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection as SqliteConnection, params};
use tauri::{AppHandle, Manager};

const DB_FILE_NAME: &str = "pilo.sqlite3";
static INITIALIZED_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

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
    let path = dir.join(DB_FILE_NAME);
    let database_existed = path.exists();
    let connection = SqliteConnection::open(&path)
        .map_err(|error| format!("failed to open Pilo SQLite index: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("failed to configure Pilo SQLite busy timeout: {error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("failed to configure Pilo SQLite connection: {error}"))?;
    ensure_schema(&path, &connection, !database_existed)?;
    Ok(connection)
}

fn ensure_schema(path: &Path, db: &SqliteConnection, force: bool) -> Result<(), String> {
    let initialized = INITIALIZED_DATABASES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut initialized = initialized
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !force && initialized.contains(path) {
        return Ok(());
    }
    initialize_schema(db)?;
    initialized.insert(path.to_owned());
    Ok(())
}

pub(super) fn initialize_schema(db: &SqliteConnection) -> Result<(), String> {
    migrate_legacy_workspaces_schema(db)?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS connections (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           kind_json TEXT NOT NULL,
           pi_executable TEXT,
           pi_runtime TEXT NOT NULL DEFAULT 'workspace',
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS connection_naming_models (
           connection_id TEXT PRIMARY KEY,
           provider TEXT NOT NULL,
           model_id TEXT NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS projects (
           id TEXT PRIMARY KEY,
           connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           path TEXT NOT NULL,
           metadata_json TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           last_opened_at_ms INTEGER NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_projects_recent ON projects(last_opened_at_ms DESC);
         CREATE TABLE IF NOT EXISTS project_model_cache (
           project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
           models_json TEXT NOT NULL,
           default_model_json TEXT,
           default_thinking_level TEXT,
           refreshed_at_ms INTEGER NOT NULL
         );
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
           title_override TEXT,
           updated_at_ms INTEGER NOT NULL
         );",
    )
    .map_err(|error| format!("failed to initialize Pilo SQLite schema: {error}"))?;
    ensure_connection_columns(db)?;
    ensure_project_columns(db)?;
    ensure_project_model_cache_columns(db)?;
    Ok(())
}

fn ensure_connection_columns(db: &SqliteConnection) -> Result<(), String> {
    let has_pi_executable = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('connections') WHERE name='pi_executable')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| error.to_string())?;
    if !has_pi_executable {
        db.execute_batch(
            "ALTER TABLE connections ADD COLUMN pi_executable TEXT;
             UPDATE connections SET name='本地' WHERE id='local' AND name='Local';",
        )
        .map_err(|error| error.to_string())?;
    }
    let has_pi_runtime = column_exists(db, "connections", "pi_runtime")?;
    if !has_pi_runtime {
        db.execute_batch(
            "ALTER TABLE connections ADD COLUMN pi_runtime TEXT NOT NULL DEFAULT 'workspace';",
        )
        .map_err(|error| error.to_string())?;
        // Pi 运行位置从 project 迁移到 connection：旧库按项目记录的值
        // 提升到对应连接（同一连接下存在 local 项目即为 local）。
        if column_exists(db, "projects", "pi_runtime")? {
            db.execute_batch(
                "UPDATE connections SET pi_runtime='local'
                 WHERE id IN (SELECT DISTINCT connection_id FROM projects WHERE pi_runtime='local');",
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn column_exists(db: &SqliteConnection, table: &str, name: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        params![table, name],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|error| error.to_string())
}

fn ensure_project_columns(db: &SqliteConnection) -> Result<(), String> {
    let has_sort_order = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name='sort_order')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| error.to_string())?;
    if !has_sort_order {
        db.execute_batch(
            "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
             UPDATE projects
             SET sort_order=(
               SELECT COUNT(*)
               FROM projects newer
               WHERE newer.connection_id=projects.connection_id
                 AND (
                   newer.last_opened_at_ms>projects.last_opened_at_ms
                   OR (
                     newer.last_opened_at_ms=projects.last_opened_at_ms
                     AND newer.name<projects.name
                   )
                 )
             );",
        )
        .map_err(|error| error.to_string())?;
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_projects_connection_sort
         ON projects(connection_id,sort_order,name);",
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_project_model_cache_columns(db: &SqliteConnection) -> Result<(), String> {
    let has_column = |name: &str| {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_model_cache') WHERE name=?1)",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| error.to_string())
    };
    if !has_column("default_model_json")? {
        db.execute_batch("ALTER TABLE project_model_cache ADD COLUMN default_model_json TEXT;")
            .map_err(|error| error.to_string())?;
    }
    if !has_column("default_thinking_level")? {
        db.execute_batch("ALTER TABLE project_model_cache ADD COLUMN default_thinking_level TEXT;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 早期版本把项目存为 `workspaces` 表、`sessions.workspace_id` 和 `workspace:` id 前缀。
/// 这里就地改名，否则旧库升级后 project 查询会整体失败。
fn migrate_legacy_workspaces_schema(db: &SqliteConnection) -> Result<(), String> {
    if !table_exists(db, "workspaces")? {
        return Ok(());
    }
    if table_exists(db, "projects")? {
        // 新代码可能已经建出空的 projects 表，改名前先丢弃它。
        let project_count: i64 = db
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if project_count != 0 {
            return Err(
                "cannot migrate legacy workspaces: both 'workspaces' and a non-empty 'projects' table exist"
                    .to_owned(),
            );
        }
        db.execute_batch("DROP TABLE projects")
            .map_err(|error| error.to_string())?;
    }
    db.execute_batch(
        "BEGIN;
         PRAGMA defer_foreign_keys = ON;
         ALTER TABLE workspaces RENAME TO projects;
         ALTER TABLE sessions RENAME COLUMN workspace_id TO project_id;
         UPDATE projects SET id='project:'||substr(id,11) WHERE id LIKE 'workspace:%';
         UPDATE sessions SET project_id='project:'||substr(project_id,11) WHERE project_id LIKE 'workspace:%';
         DROP INDEX IF EXISTS idx_workspaces_recent;
         DROP INDEX IF EXISTS idx_sessions_workspace_updated;
         DROP INDEX IF EXISTS idx_sessions_workspace_pi_id;
         COMMIT;",
    )
    .map_err(|error| format!("failed to migrate legacy workspaces schema: {error}"))?;
    Ok(())
}

pub(super) fn table_exists(db: &SqliteConnection, name: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|error| error.to_string())
}
