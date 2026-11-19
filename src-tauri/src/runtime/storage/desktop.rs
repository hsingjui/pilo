use crate::domain::AutostartMode;
use rusqlite::{Connection, OptionalExtension, params};

pub fn get_autostart_mode(db: &Connection) -> Result<AutostartMode, String> {
    let value: Option<String> = db
        .query_row(
            "SELECT autostart_mode FROM desktop_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    value
        .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
        .map(|mode| mode.unwrap_or_default())
}

pub fn set_autostart_mode(db: &Connection, mode: AutostartMode) -> Result<(), String> {
    let value = serde_json::to_string(&mode).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO desktop_settings(id, autostart_mode) VALUES(1, ?1)
         ON CONFLICT(id) DO UPDATE SET autostart_mode = excluded.autostart_mode",
        params![value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

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
    Ok(value.unwrap_or_else(|| crate::domain::DEFAULT_SHOW_SHORTCUT.into()))
}

pub fn set_show_shortcut(db: &Connection, shortcut: &str) -> Result<(), String> {
    db.execute(
        r#"INSERT INTO desktop_settings(id, autostart_mode, show_shortcut) VALUES(1, '"disabled"', ?1)
         ON CONFLICT(id) DO UPDATE SET show_shortcut = excluded.show_shortcut"#,
        params![shortcut],
    ).map_err(|error| error.to_string())?;
    Ok(())
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
    fn shortcut_migration_and_writes_preserve_startup_settings() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE desktop_settings(id INTEGER PRIMARY KEY, autostart_mode TEXT NOT NULL);",
        )
        .unwrap();
        set_autostart_mode(&db, AutostartMode::Tray).unwrap();
        super::super::initialize_schema(&db).unwrap();
        super::super::initialize_schema(&db).unwrap();
        assert_eq!(get_show_shortcut(&db).unwrap(), "mod+alt+p");
        set_show_shortcut(&db, "ctrl+shift+o").unwrap();
        assert_eq!(get_autostart_mode(&db).unwrap(), AutostartMode::Tray);
        set_autostart_mode(&db, AutostartMode::Window).unwrap();
        assert_eq!(get_show_shortcut(&db).unwrap(), "ctrl+shift+o");
        db.execute("DELETE FROM desktop_settings", []).unwrap();
        set_show_shortcut(&db, "alt+f2").unwrap();
        assert_eq!(get_autostart_mode(&db).unwrap(), AutostartMode::Disabled);
        assert_eq!(get_show_shortcut(&db).unwrap(), "alt+f2");
    }

    #[test]
    fn autostart_defaults_disabled_and_round_trips() {
        let db = Connection::open_in_memory().unwrap();
        super::super::initialize_schema(&db).unwrap();
        assert_eq!(get_autostart_mode(&db).unwrap(), AutostartMode::Disabled);
        for mode in [
            AutostartMode::Window,
            AutostartMode::Tray,
            AutostartMode::Disabled,
        ] {
            set_autostart_mode(&db, mode).unwrap();
            assert_eq!(get_autostart_mode(&db).unwrap(), mode);
        }
    }
}
