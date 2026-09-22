# Database Guidelines

> SQLite conventions. The DB is a **desktop index/cache**, never the source of truth.

---

## Overview

- Engine: `rusqlite` (bundled SQLite), no ORM, no query builder.
- DB file: `pilo.sqlite3` in Tauri `app_data_dir()`.
- Opened through `storage::open(&app)` (`src-tauri/src/runtime/storage/schema.rs`).
- The Pi JSONL files are the single source of truth; SQLite only indexes/caches
  (`sessions`, `project_model_cache`, `session_ui_state`, …). Never copy full
  conversation data into the DB.

## Connection Setup

`storage::open` is the only entry point. It sets:

```rust
connection.busy_timeout(Duration::from_secs(2))?;
connection.execute_batch("PRAGMA foreign_keys = ON;")?;
```

Schema init is memoized per DB path via `INITIALIZED_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>>`.

## Schema & Migrations

There is no migration framework. The pattern is **idempotent DDL plus guarded column adds**:

1. `initialize_schema` runs `CREATE TABLE IF NOT EXISTS ...` and
   `CREATE INDEX IF NOT EXISTS ...` for every table.
2. New columns are added with a helper that checks `pragma_table_info`
   before `ALTER TABLE`:

```rust
fn ensure_connection_columns(db: &SqliteConnection) -> Result<(), String> {
    let has_pi_executable = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('connections') WHERE name='pi_executable')",
        [], |row| row.get::<_, i64>(0),
    ).map(|exists| exists != 0).map_err(|error| error.to_string())?;
    if !has_pi_executable {
        db.execute_batch("ALTER TABLE connections ADD COLUMN pi_executable TEXT; ...")?;
    }
    Ok(())
}
```

3. Cross-cutting renames are handled by an explicit legacy migration
   (`migrate_legacy_workspaces_schema`) so old DBs upgrade in place.

## Naming Conventions

- Tables and columns: `snake_case`.
- JSON blobs: `<name>_json` (e.g. `kind_json`, `metadata_json`).
- Millisecond timestamps: `<name>_ms` (`updated_at_ms`, `last_opened_at_ms`).
- ISO-8601 text timestamps (Pi-sourced): `created_at`, `updated_at`.
- Row IDs are text, not autoincrement: `project:<connection>:<path>` style.

## Query Patterns

- Named/positional `params![]` macros, never string interpolation in SQL.
- Store modules expose small typed functions (`list_projects`, `upsert_project`,
  `get_connection`, `ensure_local_connection`) — callers never write SQL.
- `INSERT ... ON CONFLICT ... DO UPDATE` for upserts.
- `upsert_project` deliberately does **not** overwrite the connection
  configuration — a project row references the live connection. Keep that invariant.

## Testing

Storage unit tests live in `src-tauri/src/runtime/storage.rs` under `#[cfg(test)]`
and use `SqliteConnection::open_in_memory()`. Add an in-memory test for every
new storage function.
