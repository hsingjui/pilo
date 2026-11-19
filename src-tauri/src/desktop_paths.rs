use tauri::{AppHandle, Manager};

use crate::runtime::host_paths::HostPaths;

pub(crate) fn from_app(app: &AppHandle) -> Result<HostPaths, String> {
    app.try_state::<HostPaths>()
        .map(|paths| paths.inner().clone())
        .ok_or_else(|| "Pilo host paths have not been initialized".to_owned())
}
