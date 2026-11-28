//! `pilo`: a short-lived client of the running Pilo desktop Host.
//!
//! Commands print one JSON value on stdout and exit 0; errors print a JSON
//! `{"error": {...}}` on stderr and exit non-zero (see [`error::Category`]).
//! `help` prints text.

use std::{io::Read, process::ExitCode, time::Duration};

use pilo_ipc::{DEFAULT_REQUEST_TIMEOUT, DEV_APP_ID, Endpoint};
use serde_json::{Value, json};

mod client;
mod contract;
mod error;
#[rustfmt::skip]
#[allow(dead_code)]
mod host_methods;

use client::Client;
use error::CliError;
use host_methods as m;

const HELP: &str = include_str!("help.txt");

/// The instance this binary connects to by default, injected at build time.
fn app_id() -> &'static str {
    option_env!("PILO_CLI_APP_ID").unwrap_or(DEV_APP_ID)
}

#[derive(Debug, PartialEq)]
struct Options {
    dev: bool,
    timeout: Duration,
    command: Vec<String>,
}

fn parse_options(args: impl IntoIterator<Item = String>) -> Result<Options, CliError> {
    let mut options = Options {
        dev: false,
        timeout: DEFAULT_REQUEST_TIMEOUT,
        command: Vec::new(),
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dev" => options.dev = true,
            "--timeout" => {
                let value = args
                    .next()
                    .ok_or_else(|| CliError::invalid("--timeout requires seconds"))?;
                options.timeout = parse_timeout(&value)?;
            }
            _ if arg.starts_with("--timeout=") => {
                options.timeout = parse_timeout(&arg["--timeout=".len()..])?;
            }
            "-h" | "--help" => options.command = vec!["help".to_owned()],
            "--version" => options.command = vec!["version".to_owned()],
            _ => options.command.push(arg),
        }
    }
    Ok(options)
}

fn parse_timeout(value: &str) -> Result<Duration, CliError> {
    value
        .parse::<f64>()
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0 && *seconds <= 86_400.0)
        .map(Duration::from_secs_f64)
        .ok_or_else(|| CliError::invalid("--timeout must be a number of seconds from 0 to 86400"))
}

/// Positional arguments and `--flag value` pairs after the command words.
struct Args {
    positional: Vec<String>,
    flags: Vec<(String, String)>,
}

impl Args {
    fn parse(words: &[String], known: &[&str]) -> Result<Self, CliError> {
        let mut positional = Vec::new();
        let mut flags = Vec::new();
        let mut words = words.iter();
        while let Some(word) = words.next() {
            if let Some(flag) = word.strip_prefix("--") {
                let (name, value) = match flag.split_once('=') {
                    Some((name, value)) => (name.to_owned(), value.to_owned()),
                    None => (
                        flag.to_owned(),
                        words.next().cloned().ok_or_else(|| {
                            CliError::invalid(format!("--{flag} requires a value"))
                        })?,
                    ),
                };
                if !known.contains(&name.as_str()) {
                    return Err(CliError::invalid(format!("unknown option --{name}")));
                }
                flags.push((name, value));
            } else {
                positional.push(word.clone());
            }
        }
        Ok(Self { positional, flags })
    }

    fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(flag, _)| flag == name)
            .map(|(_, value)| value.as_str())
    }

    fn required(&self, name: &str) -> Result<String, CliError> {
        self.flag(name)
            .map(str::to_owned)
            .ok_or_else(|| CliError::invalid(format!("--{name} is required")))
    }

    fn count(&self, name: &str) -> Result<Value, CliError> {
        self.flag(name)
            .map(|value| {
                value
                    .parse::<u64>()
                    .map(Value::from)
                    .map_err(|_| CliError::invalid(format!("--{name} must be a whole number")))
            })
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn id(&self, what: &str) -> Result<String, CliError> {
        match self.positional.as_slice() {
            [id] => Ok(id.clone()),
            [] => Err(CliError::invalid(format!("{what} is required"))),
            _ => Err(CliError::invalid("too many arguments")),
        }
    }

    fn none(&self) -> Result<(), CliError> {
        if self.positional.is_empty() {
            Ok(())
        } else {
            Err(CliError::invalid("too many arguments"))
        }
    }
}

/// Reads one JSON object from stdin and rejects fields outside `allowed`.
fn stdin_object(allowed: &[&str]) -> Result<serde_json::Map<String, Value>, CliError> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| CliError::invalid(format!("could not read stdin: {error}")))?;
    parse_object(&input, allowed)
}

/// Reads one JSON object from stdin; the Host validates its fields.
fn stdin_any_object() -> Result<serde_json::Map<String, Value>, CliError> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| CliError::invalid(format!("could not read stdin: {error}")))?;
    match serde_json::from_str(&input) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(CliError::invalid("stdin must be one JSON object")),
    }
}

fn parse_object(input: &str, allowed: &[&str]) -> Result<serde_json::Map<String, Value>, CliError> {
    let Ok(Value::Object(object)) = serde_json::from_str(input) else {
        return Err(CliError::invalid("stdin must be one JSON object"));
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(CliError::invalid(format!(
            "unknown field '{key}'; expected {}",
            allowed.join(", ")
        )));
    }
    Ok(object)
}

fn text_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    required: bool,
) -> Result<Value, CliError> {
    match object.get(key) {
        Some(Value::String(text)) => Ok(json!(text)),
        None | Some(Value::Null) if !required => Ok(Value::Null),
        None => Err(CliError::invalid(format!("field '{key}' is required"))),
        Some(_) => Err(CliError::invalid(format!("field '{key}' must be a string"))),
    }
}

/// Commands that need a Host connection, as `(words consumed, write)`.
fn host_command(words: &[String]) -> Option<(usize, bool)> {
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let entry = match words.as_slice() {
        ["settings", "theme", "get", ..] => (3, false),
        ["settings", "theme", "set", ..] => (3, true),
        ["settings", "get", ..] => (2, false),
        ["settings", "patch", ..] => (2, true),
        ["projects", "list", ..] => (2, false),
        ["projects", "add" | "remove", ..] => (2, true),
        ["sessions", "list" | "get" | "history" | "status", ..] => (2, false),
        [
            "sessions",
            "create" | "send" | "abort" | "stop" | "archive" | "restore" | "delete" | "update",
            ..,
        ] => (2, true),
        _ => return None,
    };
    Some(entry)
}

async fn run_host(client: &mut Client, words: &[String], write: bool) -> Result<Value, CliError> {
    let command = (words[0].as_str(), words[1].as_str());
    let (consumed, _) = host_command(words).expect("checked by the caller");
    let rest = &words[consumed..];
    let project_flags: &[&str] = match command {
        ("sessions", "list") => &["project", "offset", "limit"],
        ("sessions", "history") => &["project", "start", "limit"],
        ("sessions", _) => &["project"],
        ("projects", "add") => &["connection", "path"],
        _ => &[],
    };
    let args = Args::parse(rest, project_flags)?;
    let mut call = async |method: &contract::Method, fields: &[(&str, Value)]| {
        client.call(method, fields, write).await
    };
    match (command.0, command.1, consumed) {
        ("settings", "theme", 3) => {
            args.none()?;
            if words[2] == "get" {
                call(&m::THEME_GET, &[]).await
            } else {
                let update = Value::Object(stdin_any_object()?);
                call(&m::THEME_SET, &[("update", update)]).await
            }
        }
        ("settings", "get", _) => {
            args.none()?;
            call(&m::PREFERENCES_GET, &[]).await
        }
        ("settings", "patch", _) => {
            args.none()?;
            let patch_object = stdin_any_object()?;
            call(
                &m::PREFERENCES_PATCH,
                &[("patch", Value::Object(patch_object))],
            )
            .await
        }
        ("projects", "list", _) => {
            args.none()?;
            call(&m::PROJECT_LIST, &[]).await
        }
        ("projects", "add", _) => {
            args.none()?;
            let connection = args.flag("connection").unwrap_or("local").to_owned();
            call(
                &m::PROJECT_ADD,
                &[
                    ("connectionId", json!(connection)),
                    ("path", json!(args.required("path")?)),
                ],
            )
            .await
        }
        ("projects", "remove", _) => {
            let project = args.id("project ID")?;
            call(&m::PROJECT_REMOVE, &[("projectId", json!(project))]).await
        }
        ("sessions", "list", _) => {
            args.none()?;
            call(
                &m::SESSION_PAGE,
                &[
                    ("projectId", json!(args.required("project")?)),
                    ("offset", args.count("offset")?),
                    ("limit", args.count("limit")?),
                ],
            )
            .await
        }
        ("sessions", "create", _) => {
            args.none()?;
            let input = stdin_object(&["message", "title"])?;
            call(
                &m::SESSION_CREATE,
                &[
                    ("projectId", json!(args.required("project")?)),
                    ("message", text_field(&input, "message", true)?),
                    ("title", text_field(&input, "title", false)?),
                ],
            )
            .await
        }
        ("sessions", action, _) => {
            let project = json!(args.required("project")?);
            let session = json!(args.id("session ID")?);
            let target = [
                ("projectId", project.clone()),
                ("sessionId", session.clone()),
            ];
            match action {
                "get" => call(&m::SESSION_RESOLVE, &target).await,
                "status" => call(&m::SESSION_STATUS, &target).await,
                "abort" => call(&m::SESSION_ABORT, &target).await,
                "stop" => call(&m::SESSION_STOP, &target).await,
                "delete" => call(&m::SESSION_TRASH, &target).await,
                "send" => {
                    let input = stdin_object(&["message"])?;
                    let message = text_field(&input, "message", true)?;
                    call(
                        &m::SESSION_SEND,
                        &[target[0].clone(), target[1].clone(), ("message", message)],
                    )
                    .await
                }
                "update" => {
                    let input = stdin_object(&["title", "pinned"])?;
                    let pinned = match input.get("pinned") {
                        None | Some(Value::Null) => Value::Null,
                        Some(Value::Bool(pinned)) => json!(pinned),
                        Some(_) => {
                            return Err(CliError::invalid("field 'pinned' must be a boolean"));
                        }
                    };
                    let title = text_field(&input, "title", false)?;
                    if title.is_null() && pinned.is_null() {
                        return Err(CliError::invalid("stdin must set title or pinned"));
                    }
                    call(
                        &m::SESSION_UPDATE,
                        &[
                            target[0].clone(),
                            target[1].clone(),
                            ("title", title),
                            ("pinned", pinned),
                        ],
                    )
                    .await
                }
                "history" | "archive" | "restore" => {
                    let resolved = call(&m::SESSION_RESOLVE, &target).await?;
                    let path = resolved["saved"]["sessionPath"]
                        .as_str()
                        .ok_or_else(|| CliError::from_host(
                            &json!({"code": "conflict", "message": "the session has not been saved yet"}),
                            false,
                        ))?
                        .to_owned();
                    if action == "history" {
                        call(
                            &m::SESSION_HISTORY,
                            &[
                                ("projectId", project),
                                ("sessionPath", json!(path)),
                                ("startMessage", args.count("start")?),
                                (
                                    "messageLimit",
                                    args.count("limit")?
                                        .as_u64()
                                        .map(|limit| json!(limit.clamp(1, 100)))
                                        .unwrap_or(json!(24)),
                                ),
                                ("includeMessageIndex", json!(false)),
                            ],
                        )
                        .await
                    } else {
                        call(
                            &m::SESSION_UI_STATE_SET,
                            &[
                                ("projectId", project),
                                ("sessionPath", json!(path)),
                                ("update", json!({"archived": action == "archive"})),
                            ],
                        )
                        .await
                    }
                }
                _ => unreachable!("listed in host_command"),
            }
        }
        _ => unreachable!("listed in host_command"),
    }
}

async fn run(options: Options) -> Result<Option<Value>, CliError> {
    let words = &options.command;
    match words.first().map(String::as_str) {
        None | Some("help") => {
            print!("{HELP}");
            return Ok(None);
        }
        Some("version") if words.len() == 1 => {
            let app_id = if options.dev { DEV_APP_ID } else { app_id() };
            return Ok(Some(
                json!({"cli": env!("CARGO_PKG_VERSION"), "appId": app_id}),
            ));
        }
        _ => {}
    }
    let (_, write) = host_command(words).ok_or_else(|| {
        CliError::invalid(format!(
            "unknown command '{}'; see pilo help",
            words.join(" ")
        ))
    })?;
    let app_id = if options.dev { DEV_APP_ID } else { app_id() };
    let endpoint = Endpoint::current(app_id).map_err(CliError::offline)?;
    let mut client = Client::connect(&endpoint, options.timeout).await?;
    run_host(&mut client, words, write).await.map(Some)
}

fn main() -> ExitCode {
    let result = parse_options(std::env::args().skip(1)).and_then(|options| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| CliError::internal(error.to_string()))?
            .block_on(run(options))
    });
    match result {
        Ok(Some(value)) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Ok(None) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", error.to_json());
            ExitCode::from(error.category.exit_code() as u8)
        }
    }
}

#[cfg(test)]
mod tests;
