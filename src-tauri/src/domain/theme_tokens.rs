use std::{collections::BTreeMap, sync::LazyLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeTokenKind {
    Color,
    OpaqueColor,
    Length,
    Number,
    Font,
}

pub type ThemeTokenCatalog = BTreeMap<String, ThemeTokenKind>;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomThemeTokens {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub theme: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub light: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dark: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum ThemeTokenIssue {
    NotAnObject {
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    UnknownScope {
        scope: String,
    },
    UnknownToken {
        scope: String,
        token: String,
    },
    InvalidValue {
        scope: String,
        token: String,
        expected: ThemeTokenKind,
    },
    AppearanceNotAllowed {
        scope: String,
        token: String,
    },
    ConflictingScope {
        scope: String,
        token: String,
    },
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn number(s: &str) -> Option<f64> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\A[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)\z").expect("number regex")
    });
    RE.is_match(s)
        .then(|| s.parse::<f64>().ok())
        .flatten()
        .filter(|n| n.is_finite())
}

fn percent(s: &str) -> Option<f64> {
    number(s.strip_suffix('%')?).filter(|v| (0.0..=100.0).contains(v))
}

pub fn parse_theme_length(value: &str) -> Option<f64> {
    let text = trim(value);
    let (n, scale) = text
        .strip_suffix("rem")
        .map(|n| (n, 16.0))
        .or_else(|| text.strip_suffix("px").map(|n| (n, 1.0)))?;
    number(n)
        .map(|n| n * scale)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

pub fn parse_theme_color(value: &str) -> Option<String> {
    let text = trim(value);
    if text == "transparent" {
        return Some("#00000000".into());
    }
    if let Some(hex) = text.strip_prefix('#')
        && matches!(hex.len(), 3 | 4 | 6 | 8)
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let mut full = if hex.len() <= 4 {
            hex.chars().flat_map(|c| [c, c]).collect::<String>()
        } else {
            hex.to_owned()
        };
        while full.len() < 8 {
            full.push('f');
        }
        return Some(format!("#{}", full.to_ascii_lowercase()));
    }
    let (name, rest) = text.split_once('(')?;
    if !matches!(name, "rgb" | "rgba" | "hsl" | "hsla") {
        return None;
    }
    let body = rest.strip_suffix(')')?;
    if body.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let body = trim(body);
    let parts: Vec<&str> = if body.contains(',') {
        if body.contains('/') {
            return None;
        }
        body.split(',').map(trim).collect()
    } else {
        let mut split = body.split('/');
        let mut parts: Vec<_> = trim(split.next()?)
            .split(js_space)
            .filter(|s| !s.is_empty())
            .collect();
        if let Some(alpha) = split.next() {
            if parts.len() != 3 || split.next().is_some() {
                return None;
            }
            parts.push(trim(alpha));
        }
        parts
    };
    if !matches!(parts.len(), 3 | 4) {
        return None;
    }
    let alpha = if parts.len() == 3 {
        1.0
    } else if parts[3].ends_with('%') {
        percent(parts[3])? / 100.0
    } else {
        number(parts[3]).filter(|n| (0.0..=1.0).contains(n))?
    };
    let rgb = if name.starts_with("rgb") {
        let is_percent = parts[0].ends_with('%');
        let mut rgb = [0.0; 3];
        for (i, part) in parts[..3].iter().enumerate() {
            if part.ends_with('%') != is_percent {
                return None;
            }
            rgb[i] = if is_percent {
                percent(part)? * 255.0 / 100.0
            } else {
                number(part).filter(|n| (0.0..=255.0).contains(n))?
            };
        }
        rgb
    } else {
        let hue = number(parts[0].strip_suffix("deg").unwrap_or(parts[0]))?;
        let s = percent(parts[1])? / 100.0;
        let l = percent(parts[2])? / 100.0;
        let h = ((hue % 360.0) + 360.0) % 360.0;
        let a = s * l.min(1.0 - l);
        [0.0, 8.0, 4.0].map(|n| {
            let k = (n + h / 30.0) % 12.0;
            (l - a * (-1.0_f64).max((k - 3.0).min(9.0 - k).min(1.0))) * 255.0
        })
    };
    let mut hex = String::from("#");
    for channel in [rgb[0], rgb[1], rgb[2], alpha * 255.0] {
        hex.push_str(&format!("{:02x}", channel.round() as u64));
    }
    Some(hex)
}

pub fn is_valid_theme_token_value(kind: ThemeTokenKind, value: &str) -> bool {
    if value.is_empty() || value.encode_utf16().count() > 512 || value != trim(value) {
        return false;
    }
    match kind {
        ThemeTokenKind::Color => parse_theme_color(value).is_some(),
        ThemeTokenKind::OpaqueColor => parse_theme_color(value).is_some_and(|c| c.ends_with("ff")),
        ThemeTokenKind::Length => parse_theme_length(value).is_some(),
        ThemeTokenKind::Number => number(value).is_some(),
        ThemeTokenKind::Font => {
            static RE: LazyLock<Regex> = LazyLock::new(|| {
                Regex::new(r#"\A(?:"[^"\\]+"|'[^'\\]+'|[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*)\z"#)
                    .expect("font regex")
            });
            value.split(',').all(|family| RE.is_match(trim(family)))
        }
    }
}

pub fn create_theme_token_catalog(base: &Value) -> Result<ThemeTokenCatalog, String> {
    let mut catalog = ThemeTokenCatalog::new();
    for scope in ["theme", "light", "dark"] {
        if let Some(entries) = base.get(scope).and_then(Value::as_object) {
            for (name, value) in entries {
                let kind = if name.starts_with("font-") {
                    ThemeTokenKind::Font
                } else if value.is_number() {
                    ThemeTokenKind::Number
                } else if let Some(text) = value.as_str() {
                    if parse_theme_color(text).is_some()
                        || ["color-mix(", "oklch(", "oklab(", "lab(", "lch("]
                            .iter()
                            .any(|prefix| text.starts_with(prefix))
                    {
                        if name.starts_with("pilo-") {
                            ThemeTokenKind::Color
                        } else {
                            ThemeTokenKind::OpaqueColor
                        }
                    } else if parse_theme_length(text).is_some() {
                        ThemeTokenKind::Length
                    } else if number(text).is_some() {
                        ThemeTokenKind::Number
                    } else {
                        return Err(format!("Unsupported base theme token --{name}: {value}"));
                    }
                } else {
                    return Err(format!("Unsupported base theme token --{name}: {value}"));
                };
                if let Some(known) = catalog.insert(name.clone(), kind)
                    && known != kind
                {
                    return Err(format!("Base theme token --{name} has conflicting kinds"));
                }
            }
        }
    }
    Ok(catalog)
}

pub fn theme_token_catalog() -> &'static ThemeTokenCatalog {
    static CATALOG: LazyLock<ThemeTokenCatalog> = LazyLock::new(|| {
        let base: Value = serde_json::from_str(include_str!("../../../desktop/theme.json"))
            .expect("embedded theme JSON");
        create_theme_token_catalog(&base["cssVars"]).expect("embedded theme token kinds")
    });
    &CATALOG
}

pub fn validate_custom_theme_tokens(
    input: &Value,
    catalog: &ThemeTokenCatalog,
) -> Result<CustomThemeTokens, Vec<ThemeTokenIssue>> {
    let Some(input) = input.as_object() else {
        return Err(vec![ThemeTokenIssue::NotAnObject { scope: None }]);
    };
    let mut issues = Vec::new();
    let mut tokens = CustomThemeTokens::default();
    for scope in input.keys() {
        if !["theme", "light", "dark"].contains(&scope.as_str()) {
            issues.push(ThemeTokenIssue::UnknownScope {
                scope: scope.clone(),
            });
        }
    }
    for (scope, valid) in [
        ("theme", &mut tokens.theme),
        ("light", &mut tokens.light),
        ("dark", &mut tokens.dark),
    ] {
        let Some(entries) = input.get(scope) else {
            continue;
        };
        let Some(entries) = entries.as_object() else {
            issues.push(ThemeTokenIssue::NotAnObject {
                scope: Some(scope.into()),
            });
            continue;
        };
        for (token, value) in entries {
            let scope = scope.to_owned();
            let token = token.clone();
            let Some(&kind) = catalog.get(&token) else {
                issues.push(ThemeTokenIssue::UnknownToken { scope, token });
                continue;
            };
            if scope != "theme"
                && !matches!(kind, ThemeTokenKind::Color | ThemeTokenKind::OpaqueColor)
            {
                issues.push(ThemeTokenIssue::AppearanceNotAllowed { scope, token });
            } else if scope != "theme"
                && input
                    .get("theme")
                    .and_then(Value::as_object)
                    .is_some_and(|t| t.contains_key(&token))
            {
                issues.push(ThemeTokenIssue::ConflictingScope { scope, token });
            } else if let Some(value) = value
                .as_str()
                .filter(|v| is_valid_theme_token_value(kind, v))
            {
                valid.insert(token, value.into());
            } else {
                issues.push(ThemeTokenIssue::InvalidValue {
                    scope,
                    token,
                    expected: kind,
                });
            }
        }
    }
    if issues.is_empty() {
        Ok(tokens)
    } else {
        Err(issues)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_catalog_empty_unsupported_and_conflicting_kinds() {
        assert!(
            create_theme_token_catalog(&serde_json::json!({}))
                .unwrap()
                .is_empty()
        );
        assert!(
            create_theme_token_catalog(&serde_json::json!({
                "theme": {"unsupported": "auto"}
            }))
            .is_err()
        );
        assert!(
            create_theme_token_catalog(&serde_json::json!({
                "theme": {"primary": "#fff"}, "dark": {"primary": "1px"}
            }))
            .is_err()
        );
    }

    #[test]
    fn theme_token_ts_parity() {
        let mut fixture = include_str!("../../../tests/fixtures/theme-token-cases.jsonl")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap());
        assert_eq!(
            serde_json::to_value(theme_token_catalog()).unwrap(),
            fixture.next().unwrap()["catalog"]
        );
        for case in fixture {
            if case.get("name").is_none() {
                assert_eq!(
                    serde_json::to_value(parse_theme_color(case["input"].as_str().unwrap()))
                        .unwrap(),
                    case["expected"],
                    "{}",
                    case["input"]
                );
                continue;
            }
            let mut actual =
                match validate_custom_theme_tokens(&case["input"], theme_token_catalog()) {
                    Ok(tokens) => serde_json::json!({"ok": true, "tokens": tokens}),
                    Err(issues) => serde_json::json!({"ok": false, "issues": issues}),
                };
            let mut expected = case["expected"].clone();
            for verdict in [&mut actual, &mut expected] {
                if let Some(issues) = verdict.get_mut("issues").and_then(Value::as_array_mut) {
                    issues.sort_by_key(Value::to_string);
                }
            }
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
}
