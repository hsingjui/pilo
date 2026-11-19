use tauri::{AppHandle, Manager};

use crate::runtime::host_paths::HostPaths;

pub(crate) fn initialize(app: &AppHandle) -> Result<HostPaths, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let app = app.clone();
    Ok(HostPaths::with_data_dir_resolver(resource_dir, move || {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve Pilo app data directory: {error}"))
    }))
}

pub(crate) fn from_app(app: &AppHandle) -> Result<HostPaths, String> {
    app.try_state::<HostPaths>()
        .map(|paths| paths.inner().clone())
        .ok_or_else(|| "Pilo host paths have not been initialized".to_owned())
}
