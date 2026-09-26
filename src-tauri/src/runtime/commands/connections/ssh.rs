use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::domain::{Connection, ConnectionKind, SshAuthMethod};

use super::{
    ConnectionTestResult, PiloRuntime, connection_test_result, credentials,
    stop_connection_projects, storage,
};

#[derive(Clone, Debug, serde::Serialize)]
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
pub fn ssh_connection_password_get(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let db = storage::open(&app)?;
    let connection = storage::get_connection(&db, id.trim())?
        .ok_or_else(|| format!("SSH connection '{id}' was not found"))?;
    ensure_ssh_connection(&connection)?;
    Ok(credentials::get_ssh_password(&connection.id).ok())
}

#[tauri::command]
pub async fn ssh_connection_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<(), String> {
    stop_connection_projects(&app, &runtime, &id).await?;
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

// Tests an SSH connection straight from the editor draft, before it is saved.
#[tauri::command]
pub async fn ssh_connection_test_draft(
    runtime: State<'_, PiloRuntime>,
    connection: Connection,
    password: Option<String>,
) -> Result<ConnectionTestResult, String> {
    if !matches!(connection.kind, ConnectionKind::Ssh { .. }) || connection.id.trim().is_empty() {
        return Err("a draft SSH connection is required".to_owned());
    }
    let password_auth = matches!(
        &connection.kind,
        ConnectionKind::Ssh { target }
            if matches!(target.auth_method(), SshAuthMethod::Password)
    );
    if !password_auth {
        return connection_test_result(runtime.servers.test_connection(&connection).await?);
    }
    let password = match password {
        Some(password) => password,
        None => credentials::get_ssh_password(&connection.id)
            .map_err(|_| "SSH password is required".to_owned())?,
    };
    static DRAFT_SEQ: AtomicU64 = AtomicU64::new(0);
    let mut draft = connection.clone();
    draft.id = format!(
        "{}::draft:{}",
        connection.id,
        DRAFT_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    credentials::set_ssh_password(&draft.id, &password)?;
    let result = runtime.servers.test_connection(&draft).await;
    let _ = credentials::delete_ssh_password(&draft.id);
    connection_test_result(result?)
}
