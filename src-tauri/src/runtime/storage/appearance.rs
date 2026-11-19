use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::domain::{SavedCustomTheme, ThemeSettings, ThemeSettingsUpdate};

pub(crate) fn get_theme_settings(db: &Connection) -> Result<ThemeSettings, String> {
    let json: Option<String> = db
        .query_row(
            "SELECT settings_json FROM theme_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    json.map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(crate) fn initialize_theme_settings(
    db: &Connection,
    mut initial: ThemeSettings,
) -> Result<ThemeSettings, String> {
    initial.revision = 1;
    let json = serde_json::to_string(&initial).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO theme_settings(id, settings_json) VALUES(1, ?1) ON CONFLICT(id) DO NOTHING",
        [json],
    )
    .map_err(|error| error.to_string())?;
    get_theme_settings(db)
}

pub(crate) fn update_theme_settings(
    db: &mut Connection,
    update: ThemeSettingsUpdate,
) -> Result<ThemeSettings, String> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut settings = get_theme_settings(&tx)?;
    if let Some(theme) = update.theme {
        settings.theme = theme;
    }
    if let Some(family) = update.theme_family {
        settings.theme_family = family;
    }
    if let Some(css) = update.theme_custom_css {
        settings.theme_custom_css = css;
    }
    if let Some(tokens) = update.theme_custom_tokens {
        settings.theme_custom_tokens = tokens;
    }
    if let Some(name) = update.theme_custom_name {
        settings.theme_custom_name = name;
    }
    if let Some(mut theme) = update.save_custom_theme {
        theme.name = theme.name.trim().to_owned();
        if theme.name.is_empty() {
            return Err("theme name cannot be empty".to_owned());
        }
        let css = if let Some(css) = theme.css {
            settings.theme_custom_css = css.clone();
            css
        } else {
            settings
                .saved_custom_themes
                .iter()
                .find(|saved| saved.name == theme.name)
                .map(|saved| saved.css.clone())
                .unwrap_or_else(|| settings.theme_custom_css.clone())
        };
        settings.theme_custom_tokens = theme.tokens.clone();
        settings.theme_custom_name = theme.name.clone();
        settings
            .saved_custom_themes
            .retain(|item| item.name != theme.name);
        settings.saved_custom_themes.push(SavedCustomTheme {
            name: theme.name,
            css,
            tokens: theme.tokens,
        });
    }
    if let Some(name) = update.delete_custom_theme {
        settings
            .saved_custom_themes
            .retain(|item| item.name != name);
    }
    settings.revision += 1;
    let json = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO theme_settings(id, settings_json) VALUES(1, ?1) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json",
        params![json],
    ).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::theme_tokens::CustomThemeTokens;
    use crate::runtime::host_paths::HostPaths;
    use serde_json::{Value, json};

    struct TestDb {
        db: Connection,
        root: std::path::PathBuf,
    }

    impl TestDb {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "pilo-theme-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let paths = HostPaths::new(root.clone(), root.clone()).unwrap();
            Self {
                db: crate::runtime::storage::open(&paths).unwrap(),
                root,
            }
        }

        fn store(&self, value: Value) {
            self.db
                .execute(
                    "INSERT OR REPLACE INTO theme_settings(id, settings_json) VALUES(1, ?1)",
                    [value.to_string()],
                )
                .unwrap();
        }

        fn update(&mut self, value: Value) -> Result<ThemeSettings, String> {
            let update = serde_json::from_value(value).map_err(|error| error.to_string())?;
            update_theme_settings(&mut self.db, update)
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn theme_tokens_round_trip_save_replace_delete_and_reset() {
        let mut test = TestDb::new();
        assert_eq!(
            get_theme_settings(&test.db).unwrap(),
            ThemeSettings::default()
        );
        let tokens = json!({"theme": {"font-sans": "Inter"}, "dark": {"primary": "#abc"}});
        let settings = test
            .update(json!({"themeCustomTokens": tokens, "themeCustomCss": "legacy css"}))
            .unwrap();
        assert_eq!(settings.revision, 1);
        assert_eq!(
            serde_json::to_value(&settings.theme_custom_tokens).unwrap(),
            tokens
        );
        assert_eq!(get_theme_settings(&test.db).unwrap(), settings);
        let settings = test.update(json!({"saveCustomTheme": {"name": "  Favorite  ", "css": "rollback css", "tokens": tokens}})).unwrap();
        assert_eq!(settings.revision, 2);
        assert_eq!(settings.theme_custom_css, "rollback css");
        assert_eq!(settings.theme_custom_name, "Favorite");
        assert_eq!(settings.saved_custom_themes[0].css, "rollback css");
        assert_eq!(
            settings.saved_custom_themes[0].tokens,
            settings.theme_custom_tokens
        );
        assert_eq!(get_theme_settings(&test.db).unwrap(), settings);
        let replacement = json!({"light": {"primary": "#fff"}});
        let settings = test
            .update(json!({"saveCustomTheme": {"name": "Favorite", "tokens": replacement}}))
            .unwrap();
        assert_eq!(settings.saved_custom_themes.len(), 1);
        assert_eq!(settings.theme_custom_css, "rollback css");
        assert_eq!(settings.saved_custom_themes[0].css, "rollback css");
        assert_eq!(
            serde_json::to_value(&settings.theme_custom_tokens).unwrap(),
            replacement
        );
        let settings = test
            .update(json!({"deleteCustomTheme": "Favorite"}))
            .unwrap();
        assert!(settings.saved_custom_themes.is_empty());
        assert_eq!(
            serde_json::to_value(&settings.theme_custom_tokens).unwrap(),
            replacement
        );
        let settings = test.update(json!({"themeCustomTokens": {}})).unwrap();
        assert_eq!(settings.theme_custom_tokens, CustomThemeTokens::default());
        assert_eq!(get_theme_settings(&test.db).unwrap(), settings);
    }

    #[test]
    fn theme_old_json_and_invalid_stored_tokens_load_without_losing_css() {
        let test = TestDb::new();
        test.store(json!({"revision": 9, "themeCustomCss": "old css", "savedCustomThemes": [{"name": "Old", "css": "saved css"}]}));
        let settings = get_theme_settings(&test.db).unwrap();
        assert_eq!(settings.revision, 9);
        assert_eq!(settings.theme_custom_css, "old css");
        assert_eq!(settings.saved_custom_themes[0].css, "saved css");
        assert_eq!(settings.theme_custom_tokens, CustomThemeTokens::default());
        assert_eq!(
            settings.saved_custom_themes[0].tokens,
            CustomThemeTokens::default()
        );
        for invalid in [
            json!(null),
            json!([]),
            json!({"theme":{"removed-token":"#fff"}}),
            json!({"theme":{"primary":"bad"},"dark":{"primary":"#fff"}}),
        ] {
            test.store(json!({"revision": 10, "themeCustomCss": "keep", "themeCustomTokens": invalid, "savedCustomThemes": [{"name":"Bad", "css":"keep saved", "tokens": invalid}, {"name":"Good", "tokens":{"dark":{"primary":"#fff"}}}]}));
            let settings = get_theme_settings(&test.db).unwrap();
            assert_eq!(settings.revision, 10);
            assert_eq!(settings.theme_custom_css, "keep");
            assert_eq!(settings.theme_custom_tokens, CustomThemeTokens::default());
            assert_eq!(
                settings.saved_custom_themes[0].tokens,
                CustomThemeTokens::default()
            );
            assert_eq!(settings.saved_custom_themes[0].css, "keep saved");
            assert_eq!(
                settings.saved_custom_themes[1].tokens.dark["primary"],
                "#fff"
            );
        }
    }

    #[test]
    fn theme_token_only_saves_preserve_current_and_named_rollback_css() {
        let mut test = TestDb::new();
        test.update(json!({"themeCustomCss":"current css", "saveCustomTheme":{"name":"Saved", "css":"saved css"}})).unwrap();
        test.update(json!({"themeCustomCss":"different current css"}))
            .unwrap();
        let tokens = json!({"dark":{"primary":"#fff"}});
        let same = test
            .update(json!({"saveCustomTheme":{"name":" Saved ", "tokens":tokens}}))
            .unwrap();
        assert_eq!(same.theme_custom_css, "different current css");
        assert_eq!(same.saved_custom_themes[0].css, "saved css");
        let new = test
            .update(json!({"saveCustomTheme":{"name":"New", "tokens":tokens}}))
            .unwrap();
        assert_eq!(new.theme_custom_css, "different current css");
        assert_eq!(new.saved_custom_themes[1].css, "different current css");
        let direct = test.update(json!({"themeCustomTokens":{}})).unwrap();
        assert_eq!(direct.theme_custom_css, "different current css");
        let explicit = test
            .update(json!({"saveCustomTheme":{"name":"New", "css":"", "tokens":tokens}}))
            .unwrap();
        assert_eq!(explicit.theme_custom_css, "");
        assert_eq!(explicit.saved_custom_themes[1].css, "");
        assert_eq!(get_theme_settings(&test.db).unwrap(), explicit);
    }

    #[test]
    fn theme_stored_tables_keep_valid_entries_in_current_and_saved_themes() {
        let test = TestDb::new();
        let tokens = json!({"theme":{"font-sans":"Inter", "removed-token":"#fff"}, "light":{"primary":"#fff", "pilo-field-height":"3px"}, "dark":{"primary":"not a color", "foreground":"#000"}});
        test.store(json!({"revision":4, "themeCustomCss":"rollback", "themeCustomTokens":tokens, "savedCustomThemes":[{"name":"Saved", "css":"saved rollback", "tokens":tokens}]}));
        let settings = get_theme_settings(&test.db).unwrap();
        assert_eq!(settings.revision, 4);
        assert_eq!(
            serde_json::to_value(&settings.theme_custom_tokens).unwrap(),
            json!({"theme":{"font-sans":"Inter"},"light":{"primary":"#fff"},"dark":{"foreground":"#000"}})
        );
        assert_eq!(
            settings.saved_custom_themes[0].tokens,
            settings.theme_custom_tokens
        );
        assert_eq!(settings.theme_custom_css, "rollback");
        assert_eq!(settings.saved_custom_themes[0].css, "saved rollback");
    }

    #[test]
    fn theme_saved_tokens_are_strict_in_updates_and_lenient_in_storage() {
        let mut test = TestDb::new();
        let original = test
            .update(json!({"saveCustomTheme":{
                "name":"Saved", "css":"rollback css", "tokens":{"dark":{"primary":"#fff"}}
            }}))
            .unwrap();
        let invalid = json!({"theme":{"removed-token":"#fff"}});
        let error = test
            .update(json!({"saveCustomTheme":{
                "name":"Saved", "css":"replacement css", "tokens":invalid
            }}))
            .unwrap_err();
        assert!(error.contains("unknown-token"), "{error}");
        assert_eq!(get_theme_settings(&test.db).unwrap(), original);
        let mut stored = serde_json::to_value(&original).unwrap();
        stored["savedCustomThemes"][0]["tokens"] = invalid;
        test.store(stored);
        let loaded = get_theme_settings(&test.db).unwrap();
        assert_eq!(loaded.revision, original.revision);
        assert_eq!(loaded.saved_custom_themes[0].css, "rollback css");
        assert_eq!(
            loaded.saved_custom_themes[0].tokens,
            CustomThemeTokens::default()
        );
        assert_eq!(loaded.theme_custom_tokens, original.theme_custom_tokens);
    }

    #[test]
    fn theme_invalid_updates_list_issues_and_do_not_change_revision_or_settings() {
        let mut test = TestDb::new();
        let original = test.update(json!({"themeCustomCss":"original"})).unwrap();
        let invalid = json!({"theme":{"primary": 7, "unknown": "x"}, "dark":{"primary":"#fff"}});
        for update in [
            json!({"themeCustomCss":"changed", "themeCustomTokens": invalid}),
            json!({"themeCustomCss":"changed", "themeCustomTokens": {}, "saveCustomTheme":{"name":"Bad", "tokens":invalid}}),
        ] {
            let error = test.update(update).unwrap_err();
            for code in ["invalid-value", "unknown-token", "conflicting-scope"] {
                assert!(error.contains(code), "{error}");
            }
            assert_eq!(get_theme_settings(&test.db).unwrap(), original);
        }
        for tokens in [
            json!(null),
            json!([]),
            json!({"unknownScope":{}}),
            json!({"theme":{"primary":null}}),
        ] {
            assert!(
                test.update(json!({"themeCustomTokens":tokens}))
                    .unwrap_err()
                    .contains("issues")
            );
            assert!(
                test.update(json!({"saveCustomTheme":{"name":"Bad", "tokens":tokens}}))
                    .unwrap_err()
                    .contains("issues")
            );
            assert_eq!(get_theme_settings(&test.db).unwrap(), original);
        }
        assert!(
            test.update(json!({"saveCustomTheme":{"name":"Bad", "tokens":{}, "unexpected":true}}))
                .is_err()
        );
        assert_eq!(get_theme_settings(&test.db).unwrap(), original);
        assert!(
            test.update(json!({"saveCustomTheme":{"name":"  ", "tokens":{}}}))
                .is_err()
        );
        assert!(test.update(json!({"unexpected":true})).is_err());
        assert_eq!(get_theme_settings(&test.db).unwrap(), original);
    }
}
