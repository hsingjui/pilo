use rusqlite::{Connection, OptionalExtension, params};

pub fn get_show_shortcut(db: &Connection) -> Result<String, String> {
    let value: Option<String> = db
        .query_row(
            "SELECT show_shortcut FROM desktop_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    Ok(value.unwrap_or_else(|| pilo_domain::DEFAULT_SHOW_SHORTCUT.into()))
}

pub fn set_show_shortcut(db: &Connection, shortcut: &str) -> Result<(), String> {
    db.execute(
        r#"INSERT INTO desktop_settings(id, autostart_mode, show_shortcut) VALUES(1, '"disabled"', ?1)
         ON CONFLICT(id) DO UPDATE SET show_shortcut = excluded.show_shortcut"#,
        params![shortcut],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

/// Persists a shortcut already registered by a native shell, checking for
/// conflicts with the current application shortcuts in the same transaction.
pub fn save_registered_show_shortcut(
    paths: &crate::host_paths::HostPaths,
    shortcut: &str,
) -> Result<(), String> {
    let mut db = super::open(paths)?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    crate::shortcuts::validate_in_app_shortcut_conflicts(
        shortcut,
        &super::get_preferences(&transaction)?.values["keyboardShortcuts"],
    )?;
    set_show_shortcut(&transaction, shortcut)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn get_exit_on_close(db: &Connection) -> Result<bool, String> {
    db.query_row(
        "SELECT exit_on_close FROM desktop_settings WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(false))
    .map_err(|error| error.to_string())
}

pub fn set_exit_on_close(db: &Connection, enabled: bool) -> Result<(), String> {
    db.execute(
        r#"INSERT INTO desktop_settings(id, autostart_mode, exit_on_close) VALUES(1, '"disabled"', ?1)
         ON CONFLICT(id) DO UPDATE SET exit_on_close = excluded.exit_on_close"#,
        params![enabled],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_migration_and_writes_preserve_existing_desktop_settings_row() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE desktop_settings(id INTEGER PRIMARY KEY, autostart_mode TEXT NOT NULL);
             INSERT INTO desktop_settings(id, autostart_mode) VALUES(1, '\"tray\"');",
        )
        .unwrap();
        super::super::initialize_schema(&db).unwrap();
        super::super::initialize_schema(&db).unwrap();
        assert_eq!(get_show_shortcut(&db).unwrap(), "mod+alt+p");
        set_show_shortcut(&db, "ctrl+shift+o").unwrap();
        set_exit_on_close(&db, true).unwrap();
        assert_eq!(get_show_shortcut(&db).unwrap(), "ctrl+shift+o");
        assert!(get_exit_on_close(&db).unwrap());
        let stored_autostart: String = db
            .query_row(
                "SELECT autostart_mode FROM desktop_settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_autostart, "\"tray\"");
        db.execute("DELETE FROM desktop_settings", []).unwrap();
        set_show_shortcut(&db, "alt+f2").unwrap();
        assert_eq!(get_show_shortcut(&db).unwrap(), "alt+f2");
        assert!(!get_exit_on_close(&db).unwrap());
    }
}
