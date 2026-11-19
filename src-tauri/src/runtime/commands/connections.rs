use crate::domain::{Connection, ConnectionNamingModel};
use crate::runtime::Runtime;
pub use crate::runtime::connections::{ConnectionHealth, ConnectionTestResult};
use pilo_protocol::PiExecutableInfo;
use serde_json::Value;
use tauri::State;
mod ssh;
mod wsl;
pub use ssh::{
    ssh_agent_identities_list, ssh_connection_list, ssh_connection_password_get,
    ssh_connection_remove, ssh_connection_save, ssh_connection_test, ssh_connection_test_draft,
};
pub use wsl::{
    wsl_connection_list, wsl_connection_remove, wsl_connection_save, wsl_connection_test,
    wsl_list_distributions,
};

#[tauri::command]
pub async fn connection_models_get(
    runtime: State<'_, Runtime>,
    connection_id: String,
) -> Result<Vec<Value>, String> {
    crate::runtime::connections::connection_models_get(&runtime, connection_id).await
}

#[tauri::command]
pub fn connection_naming_model_list(
    runtime: State<'_, Runtime>,
) -> Result<Vec<ConnectionNamingModel>, String> {
    crate::runtime::connections::connection_naming_model_list(&runtime)
}

#[tauri::command]
pub fn connection_naming_model_get(
    runtime: State<'_, Runtime>,
    connection_id: String,
) -> Result<Option<ConnectionNamingModel>, String> {
    crate::runtime::connections::connection_naming_model_get(&runtime, connection_id)
}

#[tauri::command]
pub fn connection_naming_model_set(
    runtime: State<'_, Runtime>,
    connection_id: String,
    provider: Option<String>,
    model_id: Option<String>,
) -> Result<Option<ConnectionNamingModel>, String> {
    crate::runtime::connections::connection_naming_model_set(
        &runtime,
        connection_id,
        provider,
        model_id,
    )
}

#[tauri::command]
pub fn connection_shown_in_home_set(
    runtime: State<'_, Runtime>,
    id: String,
    shown: bool,
) -> Result<Connection, String> {
    crate::runtime::connections::connection_shown_in_home_set(&runtime, id, shown)
}

#[tauri::command]
pub fn local_connection_get(runtime: State<'_, Runtime>) -> Result<Connection, String> {
    crate::runtime::connections::local_connection_get(&runtime)
}

#[tauri::command]
pub fn connection_settings_update(
    runtime: State<'_, Runtime>,
    id: String,
    name: String,
    pi_executable: Option<String>,
) -> Result<Connection, String> {
    crate::runtime::connections::connection_settings_update(&runtime, id, name, pi_executable)
}

#[tauri::command]
pub async fn connection_pi_probe(
    runtime: State<'_, Runtime>,
    id: String,
    executable: Option<String>,
) -> Result<PiExecutableInfo, String> {
    crate::runtime::connections::connection_pi_probe(&runtime, id, executable).await
}

#[tauri::command]
pub async fn connection_health_get(
    runtime: State<'_, Runtime>,
    id: String,
) -> Result<ConnectionHealth, String> {
    crate::runtime::connections::connection_health_get(&runtime, id).await
}

#[tauri::command]
pub async fn local_connection_test(
    runtime: State<'_, Runtime>,
) -> Result<ConnectionTestResult, String> {
    crate::runtime::connections::local_connection_test(&runtime).await
}
