use pilo_protocol::ControlCommand;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{Runtime, host_api::HostApiError, session_ops};

use super::encode;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    message: String,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Send {
    message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    title: Option<String>,
    pinned: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    start_message: Option<usize>,
    message_limit: Option<usize>,
}

/// Adapts lease-scoped control commands to the shared session operations.
pub(super) async fn execute(
    runtime: &Runtime,
    command: ControlCommand,
    source_project: &str,
    source_session: &str,
) -> Result<Value, String> {
    let project = super::required(command.project_id.as_deref(), "--project")?;
    if project != source_project || command.connection_id.is_some() {
        return Err(
            "session control requires the current --project, without --connection".to_owned(),
        );
    }
    let method = command.method.as_str();
    match method {
        "sessions.create" => {
            let args: Create = decode(command.value)?;
            return message(session_ops::create(runtime, project, args.message, args.title).await);
        }
        "sessions.list" => {
            let page: Page = optional(command.value)?;
            return message(session_ops::page(runtime, &project, page.offset, page.limit).await);
        }
        _ => {}
    }
    let id = super::required(command.key.as_deref(), "session ID")?;
    let target = session_ops::resolve(runtime, &project, &id)
        .await
        .map_err(|error| error.message)?;
    let source = runtime.chat_sessions.state(source_session).await;
    let own_session = target.key == source_session
        || source.as_ref().is_some_and(|source| {
            target
                .entry
                .as_ref()
                .is_some_and(|entry| session_ops::owns_file(source, &entry.session_path))
        });
    if own_session
        && matches!(
            method,
            "sessions.send" | "sessions.abort" | "sessions.stop" | "sessions.delete"
        )
    {
        return Err("cannot send to, interrupt, stop or delete the calling session".to_owned());
    }
    match method {
        "sessions.get" => message(session_ops::get(runtime, &project, &id).await),
        "sessions.history" => {
            let args: History = optional(command.value)?;
            let history = session_ops::history(
                runtime,
                &target,
                &project,
                args.start_message,
                Some(args.message_limit.unwrap_or(24).min(100)),
            )
            .await
            .map_err(|error| error.message)?;
            if history.len() >= pilo_protocol::CONTROL_MAX_BYTES - 1024 {
                return Err(
                    "session history exceeds the CLI byte limit; request a smaller page".to_owned(),
                );
            }
            serde_json::from_slice(&history)
                .map_err(|_| "invalid session history response".to_owned())
        }
        "sessions.update" => {
            let args: Update = decode(command.value)?;
            encode(
                session_ops::update(runtime, &project, &id, args.title, args.pinned)
                    .await
                    .map_err(|error| error.message)?,
            )
        }
        "sessions.delete" => {
            if !source.is_some_and(|state| state.session_path.is_some()) {
                return Err(
                    "cannot safely delete until the calling session file is known".to_owned(),
                );
            }
            message(session_ops::trash(runtime, &project, &id).await)
        }
        "sessions.stop" => message(session_ops::stop(runtime, &project, &id).await),
        "sessions.abort" => message(session_ops::abort(runtime, &project, &id).await),
        "sessions.send" => {
            let args: Send = decode(command.value)?;
            message(session_ops::send(runtime, &project, &id, args.message).await)
        }
        "sessions.resume" => message(session_ops::resume(runtime, &project, &id).await),
        _ => Err("unknown session control command".to_owned()),
    }
}

fn message(result: Result<Value, HostApiError>) -> Result<Value, String> {
    result.map_err(|error| error.message)
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value)
        .map_err(|_| "invalid session JSON; consult ctl --help for the expected fields".to_owned())
}

fn optional<T: DeserializeOwned + Default>(value: Value) -> Result<T, String> {
    if value.is_null() {
        Ok(T::default())
    } else {
        decode(value)
    }
}
