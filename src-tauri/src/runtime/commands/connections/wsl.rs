use tauri::{AppHandle, State};

use crate::domain::{Connection, ConnectionKind, WslDistribution};

use super::{
    ConnectionTestResult, PiloRuntime, connection_test_result, stop_connection_projects, storage,
};
use crate::runtime::wsl::{WslConnectionError, list_wsl_distributions};

#[tauri::command]
pub async fn wsl_list_distributions() -> Result<Vec<WslDistribution>, WslConnectionError> {
    list_wsl_distributions().await
}

#[derive(Clone, Debug, serde::Serialize)]
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
    if connection.pi_runtime != crate::domain::PiRuntime::Workspace {
        return Err("Pi 运行位置仅对 SSH 连接可配置".to_owned());
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
pub async fn wsl_connection_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<(), String> {
    stop_connection_projects(&app, &runtime, &id).await?;
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
        pi_runtime: crate::domain::PiRuntime::default(),
        kind: ConnectionKind::Wsl {
            distro: distro.to_owned(),
        },
    };
    connection_test_result(runtime.servers.test_connection(&connection).await?)
}
