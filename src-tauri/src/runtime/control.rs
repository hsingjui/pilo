mod catalog;
mod settings;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use catalog::catalog;
use settings::settings;
use std::sync::Arc;

use pilo_protocol::{ControlCommand, ControlContext, ControlReply, ControlRequest};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::task::{JoinHandle, JoinSet};

use super::{
    PiloRuntime, RuntimeEventBus, commands,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    project,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient},
    storage,
};
use crate::domain::ConnectionKind;

pub(crate) struct ControlLease {
    client: Arc<ServerClient>,
    stream: String,
    task: JoinHandle<()>,
}

impl Drop for ControlLease {
    fn drop(&mut self) {
        self.task.abort();
        let client = self.client.clone();
        let stream = self.stream.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = client
                    .request("control.revoke", json!({ "streamId": stream }))
                    .await;
            });
        }
    }
}

pub(crate) async fn attach(
    app: AppHandle,
    client: Arc<ServerClient>,
    stream: String,
    project_id: &str,
    local: bool,
) -> Result<(ControlContext, ControlLease), String> {
    // Resolve from Host storage, never from a caller-supplied source identity.
    let source = project::get(&app, project_id)?;
    let mut events = client.subscribe(&stream);
    let dispatcher = client.clone();
    let source_project = source.id;
    let source_connection = source.connection.id;
    let task = tokio::spawn(async move {
        let mut work = JoinSet::new();
        loop {
            tokio::select! {
                event = events.recv() => {
                    let Some(event) = event else { break };
                    if event.event == SERVER_DISCONNECTED_EVENT { break }
                    if event.event != "control.request" { continue }
                    let Ok(request) = serde_json::from_value::<ControlRequest>(event.data) else { continue };
                    let client = dispatcher.clone();
                    let app = app.clone();
                    let source_project = source_project.clone();
                    let source_connection = source_connection.clone();
                    if work.len() >= 16 {
                        let _ = client.request("control.respond", json!({ "id": request.id, "reply": ControlReply { result: None, error: Some("Pilo control capacity exhausted".to_owned()) } })).await;
                        continue;
                    }
                    work.spawn(async move {
                        // This task is independent of the transport reader and can call the same Server.
                        let result = tokio::time::timeout(std::time::Duration::from_secs(55), execute(&app, request.command, &source_project, &source_connection)).await
                            .unwrap_or_else(|_| Err("Pilo control execution timed out; write outcome may be unknown; do not automatically retry".to_owned()));
                        let reply = match result { Ok(result) => ControlReply { result: Some(result), error: None }, Err(error) => ControlReply { result: None, error: Some(error) } };
                        let _ = client.request("control.respond", json!({ "id": request.id, "reply": reply })).await;
                    });
                }
                _ = work.join_next(), if !work.is_empty() => {}
            }
        }
    });
    let lease = ControlLease {
        client: client.clone(),
        stream: stream.clone(),
        task,
    };
    // Debug Local servers are GUI executables. Use the console runtime for ctl.
    let executable = if local && cfg!(windows) {
        let path = if cfg!(debug_assertions) {
            std::env::current_exe()
                .map_err(|_| "failed to locate Windows ctl runtime".to_owned())?
                .with_file_name("pilo-server.exe")
        } else {
            super::server_deploy::server_binary(super::server_deploy::ServerTarget::current()?)?
        };
        if !path.is_file() {
            return Err(
                "Windows ctl runtime is unavailable; start development with pnpm tauri dev"
                    .to_owned(),
            );
        }
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    };
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret)
        .map_err(|_| "failed to generate Pilo control context".to_owned())?;
    let context = serde_json::from_value(client.request("control.register", json!({ "streamId": stream, "token": URL_SAFE_NO_PAD.encode(secret), "executable": executable })).await?)
        .map_err(|_| "invalid Pilo control registration response".to_owned())?;
    Ok((context, lease))
}

pub(crate) fn changed(app: &AppHandle) {
    app.state::<RuntimeEventBus>()
        .send(RuntimeEventEnvelope::global(
            RuntimeEvent::ConfigurationChanged,
        ));
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    // Do not echo serde errors: invalid enum variants can contain credentials.
    serde_json::from_value(value)
        .map_err(|_| "invalid control value; consult settings list for the schema".to_owned())
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "control result serialization failed".to_owned())
}
fn required(value: Option<&str>, kind: &str) -> Result<String, String> {
    value
        .filter(|value| !value.trim().is_empty() && value.len() <= 4096)
        .map(str::to_owned)
        .ok_or_else(|| format!("explicit {kind} is required"))
}

async fn execute(
    app: &AppHandle,
    command: ControlCommand,
    source_project: &str,
    source_connection: &str,
) -> Result<Value, String> {
    let runtime = app.state::<PiloRuntime>();
    match command.method.as_str() {
        "status" => Ok(
            json!({ "version": env!("CARGO_PKG_VERSION"), "hostPid": std::process::id(), "sourceProjectId": source_project, "sourceConnectionId": source_connection }),
        ),
        "settings.list" => Ok(catalog()),
        "settings.get" | "settings.set" | "settings.reset" => settings(app, command).await,
        "connections.list" => {
            let db = storage::open(app)?;
            storage::ensure_local_connection(&db)?;
            storage::list_connections(&db)?.into_iter().map(|connection| {
                let has_password = matches!(connection.kind, ConnectionKind::Ssh { .. }) && super::credentials::has_ssh_password(&connection.id);
                Ok(json!({ "projectCount": storage::connection_project_count(&db, &connection.id)?, "connection": connection, "hasPassword": has_password }))
            }).collect::<Result<Vec<_>, String>>().map(Value::Array)
        }
        "connections.save" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Save {
                connection: crate::domain::Connection,
                password: Option<String>,
            }
            let save: Save = decode(command.value)?;
            validate_connection(&save.connection)?;
            if command
                .connection_id
                .as_deref()
                .is_some_and(|id| id != save.connection.id)
            {
                return Err("connection ID differs from --connection".to_owned());
            }
            if save.password.is_some()
                && !matches!(save.connection.kind, ConnectionKind::Ssh { .. })
            {
                return Err("password is only supported for SSH".to_owned());
            }
            let id = save.connection.id.clone();
            let shown = save.connection.shown_in_home;
            if let Some(existing) =
                storage::get_connection(&storage::open(app)?, &save.connection.id)?
                && std::mem::discriminant(&existing.kind)
                    != std::mem::discriminant(&save.connection.kind)
            {
                return Err(
                    "cannot change an existing connection kind; create a new connection ID"
                        .to_owned(),
                );
            }
            match &save.connection.kind {
                ConnectionKind::Ssh { .. } => {
                    commands::ssh_connection_save(
                        app.clone(),
                        commands::SaveSshConnectionRequest {
                            connection: save.connection,
                            password: save.password,
                        },
                    )?;
                }
                ConnectionKind::Wsl { .. } => {
                    commands::wsl_connection_save(app.clone(), save.connection)?;
                }
                ConnectionKind::Local => {
                    if save.password.is_some() {
                        return Err("password is only supported for SSH".to_owned());
                    }
                    storage::upsert_connection(&storage::open(app)?, &save.connection)?;
                }
            };
            let connection = commands::connection_shown_in_home_set(app.clone(), id, shown)?;
            changed(app);
            Ok(
                json!({ "hasPassword": matches!(connection.kind, ConnectionKind::Ssh { .. }) && super::credentials::has_ssh_password(&connection.id), "connection": connection, "effect": "new sessions use the saved connection; existing processes are not restarted" }),
            )
        }
        "projects.list" => encode(project::list(app)?),
        "projects.add" => {
            let connection = required(command.connection_id.as_deref(), "--connection")?;
            let path = required(command.key.as_deref(), "project path")?;
            let added = project::add(app, &runtime.servers, connection, path).await?;
            runtime.chat_sessions.open_project(&added.id).await?;
            changed(app);
            encode(added)
        }
        _ => Err("unknown Pilo control command".to_owned()),
    }
}

fn validate_connection(connection: &crate::domain::Connection) -> Result<(), String> {
    if connection.id.trim().is_empty()
        || connection.id.len() > 256
        || connection.name.trim().is_empty()
        || connection.name.len() > 256
        || connection.id.chars().any(char::is_control)
        || connection.name.chars().any(char::is_control)
    {
        return Err("invalid connection ID or name".to_owned());
    }
    match &connection.kind {
        ConnectionKind::Local
            if connection.id != "local"
                || connection.pi_runtime != crate::domain::PiRuntime::Workspace =>
        {
            return Err("Local connection must use id local and workspace runtime".to_owned());
        }
        ConnectionKind::Wsl { distro }
            if distro.trim().is_empty()
                || distro.starts_with('-')
                || distro.contains(['\0', '\n', '\r']) =>
        {
            return Err("invalid WSL distribution".to_owned());
        }
        ConnectionKind::Ssh { target } => {
            super::ssh::ssh_base_args(target)?;
        }
        _ => {}
    }
    if connection.id == "local" && !matches!(connection.kind, ConnectionKind::Local) {
        return Err("local is reserved for the Local connection".to_owned());
    }
    Ok(())
}
