use std::time::Instant;

use pilo_protocol::PiExecutableInfo;
use serde::Serialize;
use serde_json::Value;

use crate::domain::{Connection, ConnectionKind, ConnectionNamingModel};

use super::{Runtime, credentials, storage};

pub(crate) mod ssh;
pub(crate) mod wsl;

#[cfg(feature = "tauri")]
pub async fn connection_models_get(
    runtime: &Runtime,
    connection_id: String,
) -> Result<Vec<Value>, String> {
    super::connection_models::load(&runtime.paths, &runtime.core, &connection_id).await
}

pub fn connection_naming_model_list(
    runtime: &Runtime,
) -> Result<Vec<ConnectionNamingModel>, String> {
    storage::list_connection_naming_models(&storage::open(&runtime.paths)?)
}

pub fn connection_naming_model_get(
    runtime: &Runtime,
    connection_id: String,
) -> Result<Option<ConnectionNamingModel>, String> {
    storage::get_connection_naming_model(&storage::open(&runtime.paths)?, &connection_id)
}

pub fn connection_naming_model_set(
    runtime: &Runtime,
    connection_id: String,
    provider: Option<String>,
    model_id: Option<String>,
) -> Result<Option<ConnectionNamingModel>, String> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err("connection id cannot be empty".to_owned());
    }

    let db = storage::open(&runtime.paths)?;
    match (provider, model_id) {
        (None, None) => {
            storage::clear_connection_naming_model(&db, connection_id)?;
            Ok(None)
        }
        (Some(provider), Some(model_id)) => {
            let provider = provider.trim();
            let model_id = model_id.trim();
            if provider.is_empty() || model_id.is_empty() {
                return Err("provider and model id cannot be empty".to_owned());
            }
            let model = ConnectionNamingModel {
                connection_id: connection_id.to_owned(),
                provider: provider.to_owned(),
                model_id: model_id.to_owned(),
            };
            storage::upsert_connection_naming_model(&db, &model)?;
            Ok(Some(model))
        }
        _ => Err("provider and model id must be set together".to_owned()),
    }
}

pub fn connection_shown_in_home_set(
    runtime: &Runtime,
    id: String,
    shown: bool,
) -> Result<Connection, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("connection id is required".to_owned());
    }
    let db = storage::open(&runtime.paths)?;
    if !storage::set_connection_shown_in_home(&db, id, shown)? {
        return Err(format!("Connection '{id}' was not found"));
    }
    storage::get_connection(&db, id)
        .and_then(|connection| connection.ok_or_else(|| format!("Connection '{id}' was not found")))
}

pub fn local_connection_get(runtime: &Runtime) -> Result<Connection, String> {
    storage::ensure_local_connection(&storage::open(&runtime.paths)?)
}

pub fn connection_settings_update(
    runtime: &Runtime,
    id: String,
    name: String,
    pi_executable: Option<String>,
) -> Result<Connection, String> {
    let id = id.trim();
    let name = name.trim();
    if id.is_empty() || name.is_empty() {
        return Err("connection id and name are required".to_owned());
    }
    let db = storage::open(&runtime.paths)?;
    let mut connection = if id == "local" {
        storage::ensure_local_connection(&db)?
    } else {
        storage::get_connection(&db, id)?
            .ok_or_else(|| format!("Connection '{id}' was not found"))?
    };
    connection.name = name.to_owned();
    connection.pi_executable = pi_executable
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    storage::upsert_connection(&db, &connection)?;
    Ok(connection)
}

#[cfg(feature = "tauri")]
pub async fn connection_pi_probe(
    runtime: &Runtime,
    id: String,
    executable: Option<String>,
) -> Result<PiExecutableInfo, String> {
    let db = storage::open(&runtime.paths)?;
    let connection = if id == "local" {
        storage::ensure_local_connection(&db)?
    } else {
        storage::get_connection(&db, &id)?
            .ok_or_else(|| format!("Connection '{id}' was not found"))?
    };
    runtime
        .servers
        .request_typed(
            &connection,
            "environment.pi_probe",
            serde_json::json!({ "executable": executable }),
        )
        .await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub protocol_version: u64,
    pub server_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHealth {
    pub reachable: bool,
    pub latency_ms: u64,
    pub protocol_version: Option<u64>,
    pub server_version: Option<String>,
    pub pi: Option<PiExecutableInfo>,
    pub error: Option<String>,
    pub pi_error: Option<String>,
}

fn get_connection(runtime: &Runtime, id: &str) -> Result<Connection, String> {
    let db = storage::open(&runtime.paths)?;
    if id == "local" {
        storage::ensure_local_connection(&db)
    } else {
        storage::get_connection(&db, id)?.ok_or_else(|| format!("Connection '{id}' was not found"))
    }
}

fn connection_test_result(value: Value) -> Result<ConnectionTestResult, String> {
    let protocol_version = value
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "pilo-server ping response is missing protocolVersion".to_owned())?;
    let server_version = value
        .get("serverVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| "pilo-server ping response is missing serverVersion".to_owned())?
        .to_owned();
    Ok(ConnectionTestResult {
        protocol_version,
        server_version,
    })
}

#[cfg(feature = "tauri")]
pub async fn connection_health_get(
    runtime: &Runtime,
    id: String,
) -> Result<ConnectionHealth, String> {
    let connection = get_connection(runtime, id.trim())?;
    let started = Instant::now();
    if let Err(error) = runtime.servers.client(&connection).await {
        return Ok(ConnectionHealth {
            reachable: false,
            latency_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            protocol_version: None,
            server_version: None,
            pi: None,
            error: Some(error),
            pi_error: None,
        });
    }
    let started = Instant::now();
    let ping = runtime
        .servers
        .request(&connection, "server.ping", Value::Null)
        .await;
    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let ping = match ping {
        Ok(value) => value,
        Err(error) => {
            return Ok(ConnectionHealth {
                reachable: false,
                latency_ms,
                protocol_version: None,
                server_version: None,
                pi: None,
                error: Some(error),
                pi_error: None,
            });
        }
    };
    let test = connection_test_result(ping)?;
    let pi = runtime
        .servers
        .request_typed::<PiExecutableInfo>(
            &connection,
            "environment.pi_probe",
            serde_json::json!({ "executable": connection.pi_executable }),
        )
        .await;
    let (pi, pi_error) = match pi {
        Ok(info) => (Some(info), None),
        Err(error) => (None, Some(error)),
    };
    Ok(ConnectionHealth {
        reachable: true,
        latency_ms,
        protocol_version: Some(test.protocol_version),
        server_version: Some(test.server_version),
        pi,
        error: None,
        pi_error,
    })
}

#[cfg(feature = "tauri")]
pub async fn local_connection_test(runtime: &Runtime) -> Result<ConnectionTestResult, String> {
    let connection = Connection {
        id: "local".to_owned(),
        name: "Local".to_owned(),
        pi_executable: None,
        pi_runtime: crate::domain::PiRuntime::default(),
        kind: ConnectionKind::Local,
        shown_in_home: true,
    };
    connection_test_result(runtime.servers.test_connection(&connection).await?)
}

#[cfg(feature = "tauri")]
async fn stop_connection_projects(runtime: &Runtime, connection_id: &str) -> Result<(), String> {
    let project_ids = storage::list_projects(&storage::open(&runtime.paths)?)?
        .into_iter()
        .filter(|project| project.connection.id == connection_id)
        .map(|project| project.id)
        .collect::<Vec<_>>();
    for project_id in project_ids {
        runtime.chat_sessions.stop_project(&project_id).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{host_events::RecordingEvents, host_paths::HostPaths};
    use std::sync::Arc;

    #[test]
    fn connection_functions_preserve_catalog_validation_and_empty_lists() {
        let root =
            std::env::temp_dir().join(format!("pilo-runtime-connections-{}", std::process::id()));
        let runtime = Runtime::new(
            HostPaths::new(root.clone(), root.join("resources")).unwrap(),
            Arc::new(RecordingEvents::default()),
        );
        assert!(connection_naming_model_list(&runtime).unwrap().is_empty());
        assert!(ssh::ssh_connection_list(&runtime).unwrap().is_empty());
        assert!(wsl::wsl_connection_list(&runtime).unwrap().is_empty());
        let local = local_connection_get(&runtime).unwrap();
        assert_eq!(local.id, "local");
        assert!(wsl::wsl_connection_save(&runtime, local).is_err());
        assert!(connection_settings_update(&runtime, "".into(), "name".into(), None).is_err());
        assert!(
            connection_naming_model_set(&runtime, "local".into(), Some("provider".into()), None)
                .is_err()
        );
        let model = connection_naming_model_set(
            &runtime,
            "local".into(),
            Some("provider".into()),
            Some("model".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(model.model_id, "model");
        assert_eq!(
            connection_naming_model_get(&runtime, "local".into())
                .unwrap()
                .unwrap()
                .provider,
            "provider"
        );
        assert!(
            connection_naming_model_set(&runtime, "local".into(), None, None)
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
