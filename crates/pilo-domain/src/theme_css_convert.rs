use serde::{Deserialize, Serialize};

use super::theme_tokens::{
    CustomThemeTokens, ThemeTokenCatalog, ThemeTokenKind, is_valid_theme_token_value,
    parse_theme_color,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCssConversionIssue {
    pub kind: ThemeCssConversionIssueKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    pub text: String,
    pub reason: ThemeCssConversionReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemeCssConversionIssueKind {
    Rule,
    Declaration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeCssConversionReason {
    UnsupportedAtRule,
    UnsupportedSelector,
    Malformed,
    NotCustomProperty,
    UnknownToken,
    UnsupportedValue,
    InvalidValue,
    AppearanceNotAllowed,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
    Base,
    Dark,
}

fn issue(
    kind: ThemeCssConversionIssueKind,
    selector: Option<&str>,
    text: &str,
    reason: ThemeCssConversionReason,
) -> ThemeCssConversionIssue {
    ThemeCssConversionIssue {
        kind,
        selector: selector.map(str::to_owned),
        text: text.trim().to_owned(),
        reason,
    }
}

// Byte offsets retain the source verbatim; escapes, strings and comments cannot delimit a block.
fn boundary(text: &str, start: usize, delimiters: &[u8]) -> Result<usize, ()> {
    let mut chars = text.get(start..).ok_or(())?.char_indices().peekable();
    let mut stack = Vec::new();
    while let Some((offset, c)) = chars.next() {
        match c {
            '/' if chars.peek().is_some_and(|(_, c)| *c == '*') => {
                chars.next();
                let mut closed = false;
                while let Some((_, c)) = chars.next() {
                    if c == '*' && chars.peek().is_some_and(|(_, c)| *c == '/') {
                        chars.next();
                        closed = true;
                        break;
                    }
                }
                if !closed {
                    return Err(());
                }
            }
            '\'' | '"' => {
                let quote = c;
                loop {
                    match chars.next() {
                        None => return Err(()),
                        Some((_, '\\')) => {
                            chars.next().ok_or(())?;
                        }
                        Some((_, c)) if c == quote => break,
                        Some(_) => (),
                    }
                }
            }
            '\\' => {
                chars.next().ok_or(())?;
            }
            c if stack.is_empty() && c.is_ascii() && delimiters.contains(&(c as u8)) => {
                return Ok(start + offset);
            }
            '(' => stack.push(')'),
            '[' => stack.push(']'),
            '{' => stack.push('}'),
            c @ (')' | ']' | '}') if stack.pop() != Some(c) => return Err(()),
            _ => (),
        }
    }
    if stack.is_empty() {
        Ok(text.len())
    } else {
        Err(())
    }
}

fn skip_trivia(text: &str, mut i: usize) -> Result<usize, ()> {
    loop {
        while text.as_bytes().get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        if !text[i..].starts_with("/*") {
            return Ok(i);
        }
        i += text[i + 2..].find("*/").ok_or(())? + 4;
    }
}

fn without_comments(text: &str) -> String {
    let mut clean = String::new();
    let mut chars = text.chars().peekable();
    let mut quote = None;
    while let Some(c) = chars.next() {
        if c == '\\' {
            clean.push(c);
            if let Some(next) = chars.next() {
                clean.push(next);
            }
        } else if quote == Some(c) {
            quote = None;
            clean.push(c);
        } else if quote.is_none() && matches!(c, '\'' | '"') {
            quote = Some(c);
            clean.push(c);
        } else if quote.is_none() && c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
            clean.push(' ');
        } else {
            clean.push(c);
        }
    }
    clean
}

fn target(selector: &str) -> Option<Target> {
    let mut targets = selector.split(',').map(|part| match part.trim() {
        ":root" | "html" => Some(Target::Base),
        ".dark" | ":root.dark" | "html.dark" => Some(Target::Dark),
        _ => None,
    });
    let first = targets.next()??;
    targets.all(|next| next == Some(first)).then_some(first)
}

fn dynamic_value(value: &str) -> bool {
    let mut quote = None;
    let mut chars = value.char_indices();
    while let Some((i, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_none() && matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if quote.is_none() && c == '(' {
            let name = value[..i]
                .rsplit(|c: char| !c.is_ascii_alphanumeric() && c != '-')
                .next()
                .unwrap_or_default();
            if name.eq_ignore_ascii_case("var") || name.eq_ignore_ascii_case("calc") {
                return true;
            }
        }
    }
    false
}

fn declaration(
    text: &str,
    target: Target,
    catalog: &ThemeTokenCatalog,
    tokens: &mut CustomThemeTokens,
) -> Result<(), ThemeCssConversionReason> {
    let clean = without_comments(text);
    let clean = clean.trim().trim_end_matches(';');
    let (name, value) = clean
        .split_once(':')
        .ok_or(ThemeCssConversionReason::Malformed)?;
    let token = name
        .trim()
        .strip_prefix("--")
        .ok_or(ThemeCssConversionReason::NotCustomProperty)?;
    let kind = *catalog
        .get(token)
        .ok_or(ThemeCssConversionReason::UnknownToken)?;
    let color = matches!(kind, ThemeTokenKind::Color | ThemeTokenKind::OpaqueColor);
    if target == Target::Dark && !color {
        return Err(ThemeCssConversionReason::AppearanceNotAllowed);
    }
    let mut value = value.trim();
    if let Some((body, suffix)) = value.rsplit_once('!')
        && suffix.trim().eq_ignore_ascii_case("important")
    {
        value = body.trim_end();
    }
    if dynamic_value(value) {
        return Err(ThemeCssConversionReason::UnsupportedValue);
    }
    let normalized;
    if color {
        normalized = parse_theme_color(value)
            .or_else(|| parse_theme_color(&format!("hsl({value})")))
            .ok_or(ThemeCssConversionReason::InvalidValue)?;
        value = &normalized;
    }
    if !is_valid_theme_token_value(kind, value) {
        return Err(ThemeCssConversionReason::InvalidValue);
    }
    let scope = if target == Target::Dark {
        &mut tokens.dark
    } else if color {
        &mut tokens.light
    } else {
        &mut tokens.theme
    };
    scope.insert(token.to_owned(), value.to_owned());
    Ok(())
}

fn declarations(
    body: &str,
    selector: &str,
    target: Target,
    catalog: &ThemeTokenCatalog,
    tokens: &mut CustomThemeTokens,
    issues: &mut Vec<ThemeCssConversionIssue>,
) {
    let mut start = 0;
    while start < body.len() {
        start = match skip_trivia(body, start) {
            Ok(i) => i,
            Err(()) => {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Declaration,
                    Some(selector),
                    &body[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            }
        };
        if start == body.len() {
            break;
        }
        let end = match boundary(body, start, b";{") {
            Ok(end) => end,
            Err(()) => {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Declaration,
                    Some(selector),
                    &body[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            }
        };
        if body.as_bytes().get(end) == Some(&b'{') {
            let Ok(close) = boundary(body, end + 1, b"}") else {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Rule,
                    Some(selector),
                    &body[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            };
            if close == body.len() {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Rule,
                    Some(selector),
                    &body[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            }
            issues.push(issue(
                ThemeCssConversionIssueKind::Rule,
                Some(selector),
                &body[start..=close],
                ThemeCssConversionReason::UnsupportedSelector,
            ));
            start = close + 1;
            continue;
        }
        let next = (end + 1).min(body.len());
        let text = &body[start..next];
        if text.trim() != ";"
            && let Err(reason) = declaration(text, target, catalog, tokens)
        {
            issues.push(issue(
                ThemeCssConversionIssueKind::Declaration,
                Some(selector),
                text,
                reason,
            ));
        }
        start = next;
    }
}

pub fn convert_legacy_theme_css(
    css: &str,
    catalog: &ThemeTokenCatalog,
) -> (CustomThemeTokens, Vec<ThemeCssConversionIssue>) {
    let mut tokens = CustomThemeTokens::default();
    let mut issues = Vec::new();
    let mut start = 0;
    while start < css.len() {
        start = match skip_trivia(css, start) {
            Ok(i) => i,
            Err(()) => {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Rule,
                    None,
                    &css[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            }
        };
        if start == css.len() {
            break;
        }
        let end = match boundary(css, start, b"{;}") {
            Ok(end) => end,
            Err(()) => {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Rule,
                    None,
                    &css[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            }
        };
        if css.as_bytes().get(end) != Some(&b'{') {
            let next = (end + 1).min(css.len());
            issues.push(issue(
                ThemeCssConversionIssueKind::Rule,
                None,
                &css[start..next],
                if css[start..].starts_with('@') && css.as_bytes().get(end) == Some(&b';') {
                    ThemeCssConversionReason::UnsupportedAtRule
                } else {
                    ThemeCssConversionReason::Malformed
                },
            ));
            start = next;
            continue;
        }
        let close = match boundary(css, end + 1, b"}") {
            Ok(close) if close < css.len() => close,
            _ => {
                issues.push(issue(
                    ThemeCssConversionIssueKind::Rule,
                    None,
                    &css[start..],
                    ThemeCssConversionReason::Malformed,
                ));
                break;
            }
        };
        let selector = &css[start..end];
        let clean = without_comments(selector);
        if clean.starts_with('@') {
            issues.push(issue(
                ThemeCssConversionIssueKind::Rule,
                None,
                &css[start..=close],
                ThemeCssConversionReason::UnsupportedAtRule,
            ));
        } else if let Some(target) = target(clean.trim()) {
            declarations(
                &css[end + 1..close],
                selector.trim(),
                target,
                catalog,
                &mut tokens,
                &mut issues,
            );
        } else {
            issues.push(issue(
                ThemeCssConversionIssueKind::Rule,
                Some(selector.trim()),
                &css[start..=close],
                ThemeCssConversionReason::UnsupportedSelector,
            ));
        }
        start = close + 1;
    }
    (tokens, issues)
}

#[cfg(test)]
mod tests {
    use super::super::theme_tokens::{theme_token_catalog, validate_custom_theme_tokens};
    use super::*;

    fn convert(css: &str) -> (CustomThemeTokens, Vec<ThemeCssConversionIssue>) {
        let catalog = theme_token_catalog();
        let result = convert_legacy_theme_css(css, catalog);
        assert_eq!(
            validate_custom_theme_tokens(&serde_json::to_value(&result.0).unwrap(), catalog)
                .unwrap(),
            result.0
        );
        assert_eq!(convert_legacy_theme_css(css, catalog), result);
        result
    }

    fn render(tokens: &CustomThemeTokens) -> String {
        let declarations = |scope: &std::collections::BTreeMap<String, String>| {
            scope
                .iter()
                .map(|(name, value)| format!("--{name}:{value};"))
                .collect::<String>()
        };
        // The WebUI merges common scopes before emitting dark overrides. Use legacy selectors.
        format!(
            ":root{{{}{}}}.dark{{{}}}",
            declarations(&tokens.theme),
            declarations(&tokens.light),
            declarations(&tokens.dark)
        )
    }

    #[test]
    fn placeholder_supported_tokens_and_theme_overrides() {
        let placeholder = ":root { --primary: 15.9 62.4% 59.6%; --pilo-bubble-radius: 1.25rem; --pilo-button-height: 36px; --pilo-field-height: 36px; } .dark { --primary: 15.9 62.4% 59.6%; }";
        let lody = ":root { --background: 0 0% 100%; --foreground: 225 7.1% 11%; --primary: 219.7 82.2% 54%; } :root.dark { --background: 225 7.1% 11%; --primary: 219.7 82.2% 64.7%; }";
        let claude = "html { --background: 0 0% 98.8%; --foreground: 0 0% 8.2%; --primary: 14 61.7% 47%; --ring: 15.9 62.4% 59.6%; } html.dark { --background: 0 0% 8.2%; --primary: 15.9 62.4% 59.6%; }";
        for css in [placeholder, lody, claude] {
            let (tokens, issues) = convert(css);
            assert!(issues.is_empty(), "{issues:?}");
            assert!(!tokens.light.is_empty());
            assert!(!tokens.dark.is_empty());
            let (again, issues) = convert(&render(&tokens));
            assert!(issues.is_empty());
            assert_eq!(tokens, again);
        }
        let (tokens, _) = convert(placeholder);
        assert_eq!(tokens.theme["pilo-bubble-radius"], "1.25rem");
        assert!(!tokens.theme.contains_key("primary"));
        assert_eq!(
            tokens.light["primary"],
            parse_theme_color("hsl(15.9 62.4% 59.6%)").unwrap()
        );
    }

    #[test]
    fn complete_legacy_placeholder_reports_unrepresentable_layout() {
        let source = include_str!("../../../shared/theme-custom.ts");
        let example = source
            .split(" * :root {")
            .nth(1)
            .unwrap()
            .split(" * 布局入口")
            .next()
            .unwrap();
        let css = format!(
            ":root {{{}",
            example
                .lines()
                .map(|line| line.strip_prefix(" *").unwrap_or(line).trim_start())
                .collect::<Vec<_>>()
                .join("\n")
        );
        let (tokens, issues) = convert(&css);
        assert!(!tokens.light.is_empty());
        assert!(!tokens.dark.is_empty());
        assert!(!issues.is_empty());
        assert!(issues.iter().all(
            |issue| issue.kind == ThemeCssConversionIssueKind::Declaration
                && matches!(
                    issue.reason,
                    ThemeCssConversionReason::UnknownToken | ThemeCssConversionReason::InvalidValue
                )
        ));
    }

    #[test]
    fn unsupported_pieces_are_reported_verbatim() {
        let rules = [
            "@import url(\"a;b.css\");",
            "@media (width > 3px) { :root { --primary: #fff; } }",
            "@font-face { font-family: \"a}b\"; src: url(x); }",
            ":root, .dark {--primary:#fff;}",
            ":root, .unknown {--primary:#fff;}",
            ".card { content: \"};{\"; }",
            ":root[data-theme-family=custom] {--primary:#fff;}",
        ];
        let declarations = [
            "color: red;",
            "--not-a-token: 1px;",
            "--primary: var(--foreground);",
            "--pilo-field-height: calc(3px + 1px);",
            "--primary: nope;",
            "--pilo-field-height: 4px;",
        ];
        let css = format!(
            "{} :root {{ {} --primary: #123; }} .dark {{ {} }}",
            rules.join("\n"),
            declarations[..5].join(" "),
            declarations[5]
        );
        let (tokens, issues) = convert(&css);
        assert_eq!(issues.len(), rules.len() + declarations.len());
        assert_eq!(
            issues.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
            rules.into_iter().chain(declarations).collect::<Vec<_>>()
        );
        assert_eq!(
            issues.iter().map(|i| i.reason).collect::<Vec<_>>(),
            vec![
                ThemeCssConversionReason::UnsupportedAtRule,
                ThemeCssConversionReason::UnsupportedAtRule,
                ThemeCssConversionReason::UnsupportedAtRule,
                ThemeCssConversionReason::UnsupportedSelector,
                ThemeCssConversionReason::UnsupportedSelector,
                ThemeCssConversionReason::UnsupportedSelector,
                ThemeCssConversionReason::UnsupportedSelector,
                ThemeCssConversionReason::NotCustomProperty,
                ThemeCssConversionReason::UnknownToken,
                ThemeCssConversionReason::UnsupportedValue,
                ThemeCssConversionReason::UnsupportedValue,
                ThemeCssConversionReason::InvalidValue,
                ThemeCssConversionReason::AppearanceNotAllowed
            ]
        );
        assert_eq!(tokens.light["primary"], "#112233ff");
        let json = serde_json::to_value(&issues[0]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind":"rule", "text":rules[0], "reason":"unsupported-at-rule"})
        );
    }

    #[test]
    fn color_triples_alpha_and_last_valid_declaration() {
        let (tokens, issues) = convert(
            ":root, html {--primary: 220 14% 96%; --primary: 0 0% 0% ! IMPORTANT; --primary: bad; --background: 0 0% 100% / .5; --pilo-field-height: 2px;} html {--pilo-field-height: 3px;} .dark, :root.dark, html.dark {--primary: #abc; --primary: #def !important;}",
        );
        assert_eq!(tokens.light["primary"], "#000000ff");
        assert_eq!(tokens.theme["pilo-field-height"], "3px");
        assert_eq!(tokens.dark["primary"], "#ddeeffff");
        assert!(
            issues
                .iter()
                .all(|i| i.reason == ThemeCssConversionReason::InvalidValue)
        );
        let catalog = ThemeTokenCatalog::from([
            ("color".into(), ThemeTokenKind::Color),
            ("opaque".into(), ThemeTokenKind::OpaqueColor),
        ]);
        let (tokens, issues) = convert_legacy_theme_css(
            ":root {--color: 220 14% 96% / 50%; --opaque: 220 14% 96% / .5; --opaque: 220 14% 96% / .9999;}",
            &catalog,
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].reason, ThemeCssConversionReason::InvalidValue);
        assert_eq!(
            tokens.light["color"],
            parse_theme_color("hsl(220 14% 96% / 50%)").unwrap()
        );
        assert!(tokens.light["opaque"].ends_with("ff"));
        assert_eq!(
            validate_custom_theme_tokens(&serde_json::to_value(&tokens).unwrap(), &catalog)
                .unwrap(),
            tokens
        );
    }

    #[test]
    fn comments_strings_nested_blocks_and_semicolons() {
        let css = r#"/* } ; { */ :root /* selector */ { --primary: /* hi */ #abc; color: "};{;"; --font-display: "braces };{ and var(x)", serif; .nested { content: "}"; @media x { a {} } } --pilo-field-height: 4px; --primary: rgb(1, 2, 3); }"#;
        let (tokens, issues) = convert(css);
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].text, "color: \"};{;\";");
        assert_eq!(
            issues[1].reason,
            ThemeCssConversionReason::UnsupportedSelector
        );
        assert_eq!(
            issues[1].text,
            ".nested { content: \"}\"; @media x { a {} } }"
        );
        assert_eq!(
            tokens.theme["font-display"],
            "\"braces };{ and var(x)\", serif"
        );
        assert_eq!(tokens.light["primary"], "#010203ff");
        assert_eq!(tokens.theme["pilo-field-height"], "4px");
    }

    #[test]
    fn malformed_input_is_reported_without_panicking() {
        for css in [
            ":root {--primary: #fff;",
            "/* unclosed",
            ":root {--primary: \"unterminated}",
            ":root {--primary: rgb(1,2,3;}",
            "stray",
            "}",
            ":root {--primary: #fff;} /* broken",
            "@media x { .a { x:y; }",
            ":root {--primary: #fff;]}",
            ":root{--primary}",
            ":root{color:rgb(1;} tail",
            ":root{--font-display: 'escaped\\' }",
            "é\\世 {x:y;}",
        ] {
            let (_, issues) = convert(css);
            assert!(!issues.is_empty(), "{css}");
        }
    }

    #[test]
    fn unicode_comments_fonts_and_escapes_keep_source_boundaries() {
        let css = "/* 中文注释 } */ :root { --font-sans: 中文字体, '思源黑体'; --primary: #abc; }";
        let (tokens, issues) = convert(css);
        assert!(issues.is_empty());
        assert_eq!(tokens.theme["font-sans"], "中文字体, '思源黑体'");
        assert_eq!(tokens.light["primary"], "#aabbccff");
        for css in [
            "\\世 { color:red; }",
            ":root { --font-sans: '中文\\世'; --primary:#fff; }",
            "中文\\",
            ":root { --font-sans: '中文\\",
            "中文 /* 未结束",
            ":root { --primary:#fff; } /* 中文未结束",
        ] {
            let (_, issues) = convert(css);
            assert!(!issues.is_empty(), "{css}");
            assert!(issues.iter().all(|issue| css.contains(&issue.text)));
        }
        assert!(boundary("世", 1, b";").is_err());
        assert!(boundary("\\世;", 0, b";").is_ok_and(|i| i == "\\世".len()));
        assert!(boundary("中文\\", 0, b";").is_err());
    }

    #[test]
    fn arbitrary_unicode_css_never_panics_and_reports_only_source_text() {
        let alphabet = [
            'a', '0', '-', '_', ':', ';', '{', '}', '[', ']', '(', ')', '/', '*', '\'', '"', '\\',
            '@', '#', '%', '!', ',', ' ', '\n', '\t', '中', '文', '世', 'é', '😀', '\u{2003}',
        ];
        let mut seed = 0x6a09_e667_f3bc_c909_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..5000 {
            let len = (next() % 128) as usize;
            let mut css = String::new();
            for _ in 0..len {
                css.push(alphabet[(next() % alphabet.len() as u64) as usize]);
            }
            for css in [
                css.clone(),
                format!(":root{{{css}}}"),
                format!(".dark{{{css}}}"),
            ] {
                let (_, issues) = convert(&css);
                assert!(
                    issues.iter().all(|issue| css.contains(&issue.text)),
                    "{css:?}: {issues:?}"
                );
            }
        }
    }

    #[test]
    fn empty_input_and_comments_are_empty() {
        for css in ["", " \n\t", "/* :root { --primary: #fff; } */"] {
            assert_eq!(convert(css), (CustomThemeTokens::default(), Vec::new()));
        }
    }
}
