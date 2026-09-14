use std::time::Instant;

use pilo_protocol::PiExecutableInfo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::domain::{Connection, ConnectionKind, ConnectionNamingModel, WslDistribution};

use super::super::{
    PiloRuntime, credentials, storage,
    wsl::{WslConnectionError, list_wsl_distributions},
};

#[tauri::command]
pub fn connection_naming_model_list(app: AppHandle) -> Result<Vec<ConnectionNamingModel>, String> {
    storage::list_connection_naming_models(&storage::open(&app)?)
}

#[tauri::command]
pub fn connection_naming_model_get(
    app: AppHandle,
    connection_id: String,
) -> Result<Option<ConnectionNamingModel>, String> {
    storage::get_connection_naming_model(&storage::open(&app)?, &connection_id)
}

#[tauri::command]
pub fn connection_naming_model_set(
    app: AppHandle,
    connection_id: String,
    provider: Option<String>,
    model_id: Option<String>,
) -> Result<Option<ConnectionNamingModel>, String> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err("connection id cannot be empty".to_owned());
    }

    let db = storage::open(&app)?;
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

#[tauri::command]
pub fn local_connection_get(app: AppHandle) -> Result<Connection, String> {
    storage::ensure_local_connection(&storage::open(&app)?)
}

#[tauri::command]
pub fn connection_settings_update(
    app: AppHandle,
    id: String,
    name: String,
    pi_executable: Option<String>,
) -> Result<Connection, String> {
    let id = id.trim();
    let name = name.trim();
    if id.is_empty() || name.is_empty() {
        return Err("connection id and name are required".to_owned());
    }
    let db = storage::open(&app)?;
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

#[tauri::command]
pub async fn connection_pi_probe(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    executable: Option<String>,
) -> Result<PiExecutableInfo, String> {
    let db = storage::open(&app)?;
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

#[tauri::command]
pub async fn wsl_list_distributions() -> Result<Vec<WslDistribution>, WslConnectionError> {
    list_wsl_distributions().await
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

fn get_connection(app: &AppHandle, id: &str) -> Result<Connection, String> {
    let db = storage::open(app)?;
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

#[tauri::command]
pub async fn connection_health_get(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<ConnectionHealth, String> {
    let connection = get_connection(&app, id.trim())?;
    // Warm the pooled client first so the measured latency is the ping round
    // trip, not the one-off cost of spawning pilo-server (WSL/SSH especially).
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConnectionInfo {
    pub connection: Connection,
    pub project_count: u64,
}

#[tauri::command]
pub fn wsl_connection_list(app: AppHandle) -> Result<Vec<WslConnectionInfo>, String> {
    let db = storage::open(&app)?;
    storage::list_connections(&db)?
        .into_iter()
        .filter(|connection| matches!(connection.kind, ConnectionKind::Wsl { .. }))
        .map(|connection| {
            Ok(WslConnectionInfo {
                project_count: storage::connection_project_count(&db, &connection.id)?,
                connection,
            })
        })
        .collect()
}

fn ensure_wsl_connection(connection: &Connection) -> Result<(), String> {
    if !matches!(connection.kind, ConnectionKind::Wsl { .. }) {
        return Err("only WSL connections can be managed here".to_owned());
    }
    if connection.id.trim().is_empty() || connection.name.trim().is_empty() {
        return Err("WSL connection id and name are required".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn wsl_connection_save(
    app: AppHandle,
    connection: Connection,
) -> Result<WslConnectionInfo, String> {
    ensure_wsl_connection(&connection)?;
    let db = storage::open(&app)?;
    storage::upsert_connection(&db, &connection)?;
    Ok(WslConnectionInfo {
        project_count: storage::connection_project_count(&db, &connection.id)?,
        connection,
    })
}

#[tauri::command]
pub fn wsl_connection_remove(app: AppHandle, id: String) -> Result<(), String> {
    let db = storage::open(&app)?;
    storage::remove_connection(&db, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn wsl_connection_test(
    runtime: State<'_, PiloRuntime>,
    distro: String,
) -> Result<ConnectionTestResult, String> {
    let distro = distro.trim();
    if distro.is_empty() {
        return Err("WSL distribution is required".to_owned());
    }
    let connection = Connection {
        id: format!("wsl:{distro}"),
        name: format!("WSL · {distro}"),
        pi_executable: None,
        kind: ConnectionKind::Wsl {
            distro: distro.to_owned(),
        },
    };
    connection_test_result(runtime.servers.test_connection(&connection).await?)
}

#[tauri::command]
pub async fn local_connection_test(
    runtime: State<'_, PiloRuntime>,
) -> Result<ConnectionTestResult, String> {
    let connection = Connection {
        id: "local".to_owned(),
        name: "Local".to_owned(),
        pi_executable: None,
        kind: ConnectionKind::Local,
    };
    connection_test_result(runtime.servers.test_connection(&connection).await?)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInfo {
    pub connection: Connection,
    pub project_count: u64,
    pub has_password: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSshConnectionRequest {
    pub connection: Connection,
    pub password: Option<String>,
}

fn ensure_ssh_connection(connection: &Connection) -> Result<(), String> {
    if !matches!(connection.kind, ConnectionKind::Ssh { .. }) {
        return Err("only SSH connections can be managed here".to_owned());
    }
    if connection.id.trim().is_empty() || connection.name.trim().is_empty() {
        return Err("SSH connection id and name are required".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_connection_list(app: AppHandle) -> Result<Vec<SshConnectionInfo>, String> {
    let db = storage::open(&app)?;
    storage::list_connections(&db)?
        .into_iter()
        .filter(|connection| matches!(connection.kind, ConnectionKind::Ssh { .. }))
        .map(|connection| {
            Ok(SshConnectionInfo {
                project_count: storage::connection_project_count(&db, &connection.id)?,
                has_password: credentials::has_ssh_password(&connection.id),
                connection,
            })
        })
        .collect()
}

#[tauri::command]
pub fn ssh_connection_save(
    app: AppHandle,
    request: SaveSshConnectionRequest,
) -> Result<SshConnectionInfo, String> {
    ensure_ssh_connection(&request.connection)?;
    let db = storage::open(&app)?;
    let password_auth = match &request.connection.kind {
        ConnectionKind::Ssh { target } => {
            matches!(target.auth_method(), crate::domain::SshAuthMethod::Password)
        }
        _ => false,
    };
    if password_auth {
        if let Some(password) = request.password.as_deref() {
            credentials::set_ssh_password(&request.connection.id, password)?;
        } else if !credentials::has_ssh_password(&request.connection.id) {
            return Err("SSH password is required".to_owned());
        }
    } else {
        credentials::delete_ssh_password(&request.connection.id)?;
    }
    storage::upsert_connection(&db, &request.connection)?;
    Ok(SshConnectionInfo {
        project_count: storage::connection_project_count(&db, &request.connection.id)?,
        has_password: credentials::has_ssh_password(&request.connection.id),
        connection: request.connection,
    })
}

#[tauri::command]
pub fn ssh_connection_remove(app: AppHandle, id: String) -> Result<(), String> {
    let db = storage::open(&app)?;
    storage::remove_connection(&db, &id)?;
    credentials::delete_ssh_password(&id)?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_connection_test(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<ConnectionTestResult, String> {
    let db = storage::open(&app)?;
    let connection = storage::get_connection(&db, &id)?
        .ok_or_else(|| format!("SSH connection '{id}' was not found"))?;
    ensure_ssh_connection(&connection)?;
    connection_test_result(runtime.servers.test_connection(&connection).await?)
}
