use super::ConnectionTestResult;
use crate::domain::Connection;
use crate::runtime::Runtime;
pub use crate::runtime::connections::ssh::{SaveSshConnectionRequest, SshConnectionInfo};
use crate::runtime::ssh::SshAgentIdentity;
use tauri::State;

#[tauri::command]
pub async fn ssh_agent_identities_list(
    runtime: State<'_, Runtime>,
) -> Result<Vec<SshAgentIdentity>, String> {
    crate::runtime::connections::ssh::ssh_agent_identities_list(&runtime).await
}

#[tauri::command]
pub fn ssh_connection_list(runtime: State<'_, Runtime>) -> Result<Vec<SshConnectionInfo>, String> {
    crate::runtime::connections::ssh::ssh_connection_list(&runtime)
}

#[tauri::command]
pub async fn ssh_connection_save(
    runtime: State<'_, Runtime>,
    request: SaveSshConnectionRequest,
) -> Result<SshConnectionInfo, String> {
    crate::runtime::connections::ssh::ssh_connection_save(&runtime, request).await
}

#[tauri::command]
pub fn ssh_connection_password_get(
    runtime: State<'_, Runtime>,
    id: String,
) -> Result<Option<String>, String> {
    crate::runtime::connections::ssh::ssh_connection_password_get(&runtime, id)
}

#[tauri::command]
pub async fn ssh_connection_remove(runtime: State<'_, Runtime>, id: String) -> Result<(), String> {
    crate::runtime::connections::ssh::ssh_connection_remove(&runtime, id).await
}

#[tauri::command]
pub async fn ssh_connection_test(
    runtime: State<'_, Runtime>,
    id: String,
) -> Result<ConnectionTestResult, String> {
    crate::runtime::connections::ssh::ssh_connection_test(&runtime, id).await
}

#[tauri::command]
pub async fn ssh_connection_test_draft(
    runtime: State<'_, Runtime>,
    connection: Connection,
    password: Option<String>,
) -> Result<ConnectionTestResult, String> {
    crate::runtime::connections::ssh::ssh_connection_test_draft(&runtime, connection, password)
        .await
}
