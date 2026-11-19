use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::runtime::handle::HostShell;

struct TauriHostShell(AppHandle);

impl crate::runtime::web_assets::WebAssets for TauriHostShell {
    fn get(&self, path: &str) -> Option<crate::runtime::web_assets::WebAsset> {
        self.0.asset_resolver().get(path.to_owned()).map(|asset| {
            crate::runtime::web_assets::WebAsset {
                bytes: asset.bytes,
                mime_type: asset.mime_type,
            }
        })
    }
}

pub(crate) fn assets(app: &AppHandle) -> Arc<dyn crate::runtime::web_assets::WebAssets> {
    Arc::new(TauriHostShell(app.clone()))
}

impl HostShell for TauriHostShell {
    fn cache_dir(&self) -> Result<PathBuf, String> {
        self.0
            .path()
            .app_cache_dir()
            .map_err(|error| format!("failed to resolve file link cache: {error}"))
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.0
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| error.to_string())
    }

    fn pick_directory(&self) -> Option<String> {
        rfd::FileDialog::new()
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    }
}

pub(crate) fn shell(app: &AppHandle) -> Arc<dyn HostShell> {
    Arc::new(TauriHostShell(app.clone()))
}
