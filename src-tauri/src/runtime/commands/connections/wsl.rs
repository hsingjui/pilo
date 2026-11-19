use super::ConnectionTestResult;
use crate::domain::{Connection, WslDistribution};
use crate::runtime::Runtime;
pub use crate::runtime::connections::wsl::WslConnectionInfo;
use crate::runtime::wsl::WslConnectionError;
use tauri::State;

#[tauri::command]
pub async fn wsl_list_distributions(
    runtime: State<'_, Runtime>,
) -> Result<Vec<WslDistribution>, WslConnectionError> {
    crate::runtime::connections::wsl::wsl_list_distributions(&runtime).await
}

#[tauri::command]
pub fn wsl_connection_list(runtime: State<'_, Runtime>) -> Result<Vec<WslConnectionInfo>, String> {
    crate::runtime::connections::wsl::wsl_connection_list(&runtime)
}

#[tauri::command]
pub fn wsl_connection_save(
    runtime: State<'_, Runtime>,
    connection: Connection,
) -> Result<WslConnectionInfo, String> {
    crate::runtime::connections::wsl::wsl_connection_save(&runtime, connection)
}

#[tauri::command]
pub async fn wsl_connection_remove(runtime: State<'_, Runtime>, id: String) -> Result<(), String> {
    crate::runtime::connections::wsl::wsl_connection_remove(&runtime, id).await
}

#[tauri::command]
pub async fn wsl_connection_test(
    runtime: State<'_, Runtime>,
    distro: String,
) -> Result<ConnectionTestResult, String> {
    crate::runtime::connections::wsl::wsl_connection_test(&runtime, distro).await
}
