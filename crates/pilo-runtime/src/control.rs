mod catalog;
mod settings;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use catalog::catalog;
use settings::settings;
use std::sync::Arc;

use pilo_protocol::{ControlCommand, ControlContext, ControlReply, ControlRequest};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::task::{JoinHandle, JoinSet};

use super::{
    Runtime,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    handle::WeakRuntime,
    project,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient},
    storage,
};
use pilo_domain::ConnectionKind;

pub(crate) struct ControlLease {
    client: Arc<ServerClient>,
    stream: String,
    task: JoinHandle<()>,
    runtime: WeakRuntime,
    source_project: String,
    source_connection: String,
}

impl ControlLease {
    pub(crate) fn rebind(&mut self, previous: &Arc<ServerClient>, client: &Arc<ServerClient>) {
        if Arc::ptr_eq(&self.client, previous) {
            self.task.abort();
            self.task = spawn_dispatcher(
                self.runtime.clone(),
                client.clone(),
                &self.stream,
                self.source_project.clone(),
                self.source_connection.clone(),
            );
            self.client = client.clone();
        }
    }
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
    runtime: &Runtime,
    client: Arc<ServerClient>,
    stream: String,
    project_id: &str,
    local: bool,
) -> Result<(ControlContext, ControlLease), String> {
    // Resolve from Host storage, never from a caller-supplied source identity.
    let source = project::get(runtime, project_id)?;
    let task = spawn_dispatcher(
        runtime.downgrade(),
        client.clone(),
        &stream,
        source.id.clone(),
        source.connection.id.clone(),
    );
    let lease = ControlLease {
        client: client.clone(),
        stream: stream.clone(),
        task,
        runtime: runtime.downgrade(),
        source_project: source.id,
        source_connection: source.connection.id,
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
                "Windows ctl runtime is unavailable; start development with pnpm dev".to_owned(),
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

fn spawn_dispatcher(
    runtime: WeakRuntime,
    client: Arc<ServerClient>,
    stream: &str,
    source_project: String,
    source_connection: String,
) -> JoinHandle<()> {
    let mut events = client.subscribe(stream);
    let dispatcher = client;
    tokio::spawn(async move {
        let mut work = JoinSet::new();
        loop {
            tokio::select! {
                event = events.recv() => {
                    let Some(event) = event else { break };
                    if event.event == SERVER_DISCONNECTED_EVENT { break }
                    if event.event != "control.request" { continue }
                    let Ok(request) = serde_json::from_value::<ControlRequest>(event.data) else { continue };
                    let client = dispatcher.clone();
                    let Ok(runtime) = runtime.upgrade() else { break };
                    let source_project = source_project.clone();
                    let source_connection = source_connection.clone();
                    if work.len() >= 16 {
                        let _ = client.request("control.respond", json!({ "id": request.id, "reply": ControlReply { result: None, error: Some("Pilo control capacity exhausted".to_owned()) } })).await;
                        continue;
                    }
                    work.spawn(async move {
                        // This task is independent of the transport reader and can call the same Server.
                        let result = tokio::time::timeout(std::time::Duration::from_secs(55), execute(&runtime, request.command, &source_project, &source_connection)).await
                            .unwrap_or_else(|_| Err("Pilo control execution timed out; write outcome may be unknown; do not automatically retry".to_owned()));
                        let reply = match result { Ok(result) => ControlReply { result: Some(result), error: None }, Err(error) => ControlReply { result: None, error: Some(error) } };
                        let _ = client.request("control.respond", json!({ "id": request.id, "reply": reply })).await;
                    });
                }
                _ = work.join_next(), if !work.is_empty() => {}
            }
        }
    })
}

pub(crate) fn changed(runtime: &Runtime) {
    runtime.events.send(RuntimeEventEnvelope::global(
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
    runtime: &Runtime,
    command: ControlCommand,
    source_project: &str,
    source_connection: &str,
) -> Result<Value, String> {
    match command.method.as_str() {
        "status" => Ok(
            json!({ "version": env!("CARGO_PKG_VERSION"), "hostPid": std::process::id(), "sourceProjectId": source_project, "sourceConnectionId": source_connection }),
        ),
        "settings.list" => Ok(catalog()),
        "settings.get" | "settings.set" | "settings.reset" => settings(runtime, command).await,
        "connections.list" => {
            let db = storage::open(&runtime.paths)?;
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
                connection: pilo_domain::Connection,
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
                storage::get_connection(&storage::open(&runtime.paths)?, &save.connection.id)?
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
                    super::connections::ssh::ssh_connection_save(
                        runtime,
                        super::connections::ssh::SaveSshConnectionRequest {
                            connection: save.connection,
                            password: save.password,
                            local_pi_resources: None,
                        },
                    )
                    .await?;
                }
                ConnectionKind::Wsl { .. } => {
                    super::connections::wsl::wsl_connection_save(runtime, save.connection)?;
                }
                ConnectionKind::Local => {
                    if save.password.is_some() {
                        return Err("password is only supported for SSH".to_owned());
                    }
                    storage::upsert_connection(&storage::open(&runtime.paths)?, &save.connection)?;
                }
            };
            let connection = super::connections::connection_shown_in_home_set(runtime, id, shown)?;
            changed(runtime);
            Ok(
                json!({ "hasPassword": matches!(connection.kind, ConnectionKind::Ssh { .. }) && super::credentials::has_ssh_password(&connection.id), "connection": connection, "effect": "new sessions use the saved connection; existing processes are not restarted" }),
            )
        }
        "projects.list" => encode(project::list(runtime)?),
        "projects.add" => {
            let connection = required(command.connection_id.as_deref(), "--connection")?;
            let path = required(command.key.as_deref(), "project path")?;
            let added = project::add(runtime, &runtime.servers, connection, path).await?;
            runtime.chat_sessions.open_project(&added.id).await?;
            changed(runtime);
            encode(added)
        }
        _ => Err("unknown Pilo control command".to_owned()),
    }
}

fn validate_connection(connection: &pilo_domain::Connection) -> Result<(), String> {
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
                || connection.pi_runtime != pilo_domain::PiRuntime::Workspace =>
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn control_uses_runtime_state_and_reports_invalid_commands() {
        let root = std::env::temp_dir().join(format!(
            "pilo-control-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let runtime =
            Runtime::new(crate::host_paths::HostPaths::new(root.clone(), root.clone()).unwrap());
        let status = execute(
            &runtime,
            decode(json!({"method": "status"})).unwrap(),
            "project",
            "local",
        )
        .await
        .unwrap();
        assert_eq!(status["sourceProjectId"], "project");
        assert_eq!(status["sourceConnectionId"], "local");
        let get =
            || decode(json!({"method": "settings.get", "key": "preferences.uiFontSize"})).unwrap();
        let original = execute(&runtime, get(), "project", "local").await.unwrap();
        execute(
            &runtime,
            decode(json!({"method": "settings.set", "key": "preferences.uiFontSize", "value": 16}))
                .unwrap(),
            "project",
            "local",
        )
        .await
        .unwrap();
        assert_eq!(
            execute(&runtime, get(), "project", "local").await.unwrap()["value"],
            16
        );
        assert!(execute(&runtime, decode(json!({"method": "settings.reset", "key": "preferences.uiFontSize", "value": false})).unwrap(), "project", "local").await.is_err());
        assert!(
            execute(
                &runtime,
                decode(json!({"method": ""})).unwrap(),
                "project",
                "local"
            )
            .await
            .is_err()
        );
        assert!(!original["value"].is_null());
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
