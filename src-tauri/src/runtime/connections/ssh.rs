use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;

use crate::{
    domain::{Connection, ConnectionKind, SshAuthMethod},
    runtime::ssh::{self, SshAgentIdentity},
};

#[cfg(feature = "tauri")]
use super::stop_connection_projects;
use super::{ConnectionTestResult, Runtime, connection_test_result, credentials, storage};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInfo {
    pub connection: Connection,
    pub project_count: u64,
    pub has_password: bool,
    pub local_pi_resources: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSshConnectionRequest {
    pub connection: Connection,
    pub password: Option<String>,
    pub local_pi_resources: Option<bool>,
}

pub async fn ssh_agent_identities_list(
    _runtime: &Runtime,
) -> Result<Vec<SshAgentIdentity>, String> {
    ssh::list_agent_identities().await
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

pub fn ssh_connection_list(runtime: &Runtime) -> Result<Vec<SshConnectionInfo>, String> {
    let db = storage::open(&runtime.paths)?;
    storage::list_connections(&db)?
        .into_iter()
        .filter(|connection| matches!(connection.kind, ConnectionKind::Ssh { .. }))
        .map(|connection| {
            Ok(SshConnectionInfo {
                project_count: storage::connection_project_count(&db, &connection.id)?,
                has_password: credentials::has_ssh_password(&connection.id),
                local_pi_resources: storage::get_local_pi_resources(&db, &connection.id)?,
                connection,
            })
        })
        .collect()
}

#[cfg(feature = "tauri")]
pub async fn ssh_connection_save(
    runtime: &Runtime,
    request: SaveSshConnectionRequest,
) -> Result<SshConnectionInfo, String> {
    ensure_ssh_connection(&request.connection)?;
    let password_auth = match &request.connection.kind {
        ConnectionKind::Ssh { target } => {
            ssh::validate_agent_identity(target)?;
            matches!(target.auth_method(), SshAuthMethod::Password)
        }
        _ => false,
    };
    if password_auth
        && request.password.is_none()
        && !credentials::has_ssh_password(&request.connection.id)
    {
        return Err("SSH password is required".to_owned());
    }
    let _policy = runtime.pi_resource_policy.write().await;
    let current = {
        let db = storage::open(&runtime.paths)?;
        storage::get_local_pi_resources(&db, &request.connection.id)?
    };
    let enabled = request.connection.pi_runtime == crate::domain::PiRuntime::Local
        && request.local_pi_resources.unwrap_or(current);
    if current != enabled {
        crate::runtime::pi_workspace::stop_for_resource_change(
            &runtime.paths,
            &runtime.core,
            &request.connection.id,
        )
        .await?;
    }
    let mut db = storage::open(&runtime.paths)?;
    let db = db.transaction().map_err(|error| error.to_string())?;
    if password_auth {
        if let Some(password) = request.password.as_deref() {
            credentials::set_ssh_password(&request.connection.id, password)?;
        }
    } else {
        credentials::delete_ssh_password(&request.connection.id)?;
    }
    storage::upsert_connection(&db, &request.connection)?;
    storage::set_local_pi_resources(&db, &request.connection.id, enabled)?;
    let info = SshConnectionInfo {
        project_count: storage::connection_project_count(&db, &request.connection.id)?,
        has_password: credentials::has_ssh_password(&request.connection.id),
        local_pi_resources: enabled,
        connection: request.connection,
    };
    db.commit().map_err(|error| error.to_string())?;
    runtime
        .events
        .send(crate::runtime::events::RuntimeEventEnvelope::global(
            crate::runtime::events::RuntimeEvent::ConfigurationChanged,
        ));
    Ok(info)
}

pub fn ssh_connection_password_get(
    runtime: &Runtime,
    id: String,
) -> Result<Option<String>, String> {
    let db = storage::open(&runtime.paths)?;
    let connection = storage::get_connection(&db, id.trim())?
        .ok_or_else(|| format!("SSH connection '{id}' was not found"))?;
    ensure_ssh_connection(&connection)?;
    Ok(credentials::get_ssh_password(&connection.id).ok())
}

#[cfg(feature = "tauri")]
pub async fn ssh_connection_remove(runtime: &Runtime, id: String) -> Result<(), String> {
    let _policy = runtime.pi_resource_policy.write().await;
    stop_connection_projects(runtime, &id).await?;
    let db = storage::open(&runtime.paths)?;
    storage::remove_connection(&db, &id)?;
    credentials::delete_ssh_password(&id)?;
    Ok(())
}

#[cfg(feature = "tauri")]
pub async fn ssh_connection_test(
    runtime: &Runtime,
    id: String,
) -> Result<ConnectionTestResult, String> {
    let db = storage::open(&runtime.paths)?;
    let connection = storage::get_connection(&db, &id)?
        .ok_or_else(|| format!("SSH connection '{id}' was not found"))?;
    ensure_ssh_connection(&connection)?;
    connection_test_result(runtime.servers.test_connection(&connection).await?)
}

// Tests an SSH connection straight from the editor draft, before it is saved.
#[cfg(feature = "tauri")]
pub async fn ssh_connection_test_draft(
    runtime: &Runtime,
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
