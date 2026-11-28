//! Session/settings business handlers from the removed `pilo-server ctl` path.
//! The transport, lease and capability injection are gone; the Pilo CLI
//! migration (`.trellis/tasks/11-27-pilo-cli/implement.md` step 2) reuses or
//! replaces these handlers.

mod catalog;
mod sessions;
mod settings;

use catalog::catalog;
use settings::settings;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{
    Runtime,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    project, project_api, storage,
};
use pilo_domain::ConnectionKind;

pub(crate) const CONTROL_MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlCommand {
    pub method: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub value: Value,
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
                    crate::connection_models::invalidate(&save.connection.id);
                }
            };
            let connection = super::connections::connection_shown_in_home_set(runtime, id, shown)?;
            Ok(
                json!({ "hasPassword": matches!(connection.kind, ConnectionKind::Ssh { .. }) && super::credentials::has_ssh_password(&connection.id), "connection": connection, "effect": "new sessions use the saved connection; existing processes are not restarted" }),
            )
        }
        "projects.list" => encode(project::list(runtime)?),
        "projects.add" => {
            let connection = required(command.connection_id.as_deref(), "--connection")?;
            let path = required(command.key.as_deref(), "project path")?;
            encode(project_api::project_add(runtime, connection, path).await?)
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
