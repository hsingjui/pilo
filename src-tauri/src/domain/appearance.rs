use serde::{Deserialize, Serialize};

use super::theme_css_convert::ThemeCssConversionIssue;
use super::theme_tokens::{
    CustomThemeTokens, read_custom_theme_tokens, theme_token_catalog, validate_custom_theme_tokens,
};

fn deserialize_tokens<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<CustomThemeTokens, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    validate_custom_theme_tokens(&value, theme_token_catalog())
        .map_err(|issues| serde::de::Error::custom(serde_json::json!({ "issues": issues })))
}

fn deserialize_optional_tokens<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<CustomThemeTokens>, D::Error> {
    deserialize_tokens(deserializer).map(Some)
}

fn deserialize_stored_tokens<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<CustomThemeTokens, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(read_custom_theme_tokens(&value, theme_token_catalog()))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeFamily {
    #[default]
    Lody,
    Claude,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SavedCustomTheme {
    pub name: String,
    #[serde(default)]
    pub css: String,
    #[serde(default, deserialize_with = "deserialize_stored_tokens")]
    pub tokens: CustomThemeTokens,
    #[serde(skip)]
    pub(crate) tokens_pending_conversion: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedCustomThemeInput {
    pub name: String,
    #[serde(default)]
    pub css: Option<String>,
    #[serde(default, deserialize_with = "deserialize_tokens")]
    pub tokens: CustomThemeTokens,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeCustomConversion {
    pub current: Vec<ThemeCssConversionIssue>,
    pub saved_themes: Vec<SavedThemeConversion>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SavedThemeConversion {
    pub name: String,
    pub issues: Vec<ThemeCssConversionIssue>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeSettings {
    pub revision: u64,
    pub theme: ThemeMode,
    pub theme_family: ThemeFamily,
    pub theme_custom_css: String,
    #[serde(deserialize_with = "deserialize_stored_tokens")]
    pub theme_custom_tokens: CustomThemeTokens,
    #[serde(skip)]
    pub(crate) theme_custom_tokens_pending_conversion: bool,
    #[serde(skip_deserializing)]
    pub theme_custom_conversion: ThemeCustomConversion,
    pub theme_custom_name: String,
    pub saved_custom_themes: Vec<SavedCustomTheme>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeSettingsUpdate {
    pub theme: Option<ThemeMode>,
    pub theme_family: Option<ThemeFamily>,
    pub theme_custom_css: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_tokens")]
    pub theme_custom_tokens: Option<CustomThemeTokens>,
    #[serde(default, rename = "themeCustomConversion")]
    pub _theme_custom_conversion: serde::de::IgnoredAny,
    pub theme_custom_name: Option<String>,
    pub save_custom_theme: Option<SavedCustomThemeInput>,
    pub delete_custom_theme: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn theme_tokens_and_empty_conversion_report_are_always_serialized() {
        let value = serde_json::to_value(ThemeSettings::default()).unwrap();
        assert_eq!(value["themeCustomTokens"], json!({}));
        assert_eq!(
            value["themeCustomConversion"],
            json!({"current":[], "savedThemes":[]})
        );
        for report in [json!(null), json!(42), json!({"current":["untrusted"]})] {
            let snapshot: ThemeSettings =
                serde_json::from_value(json!({"themeCustomConversion":report})).unwrap();
            assert_eq!(
                snapshot.theme_custom_conversion,
                ThemeCustomConversion::default()
            );
            let update: ThemeSettingsUpdate = serde_json::from_value(
                json!({"themeCustomConversion":report, "themeCustomTokens":{}}),
            )
            .unwrap();
            assert_eq!(
                update.theme_custom_tokens,
                Some(CustomThemeTokens::default())
            );
        }
        assert!(
            serde_json::from_value::<ThemeSettingsUpdate>(
                json!({"themeCustomConversion":{}, "unknown":true})
            )
            .is_err()
        );
    }

    #[test]
    fn theme_settings_keep_rollback_fields_and_allow_unknown_snapshot_fields() {
        let snapshot = json!({
            "themeCustomCss":"rollback", "themeCustomTokens":{"dark":{"primary":"#fff"}},
            "futureField":true, "savedCustomThemes":[{"name":"Saved", "css":"saved rollback", "tokens":{}, "futureField":true}]
        });
        let current: ThemeSettings = serde_json::from_value(snapshot).unwrap();
        #[derive(Deserialize)]
        struct OldSavedTheme {
            name: String,
            css: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct OldSettings {
            theme_custom_css: String,
            saved_custom_themes: Vec<OldSavedTheme>,
        }
        let old: OldSettings =
            serde_json::from_value(serde_json::to_value(current).unwrap()).unwrap();
        assert_eq!(old.theme_custom_css, "rollback");
        assert_eq!(old.saved_custom_themes[0].name, "Saved");
        assert_eq!(old.saved_custom_themes[0].css, "saved rollback");
    }
}
