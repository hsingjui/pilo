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
    fn desktop_setting(
        &self,
        key: String,
        value: Option<serde_json::Value>,
    ) -> crate::runtime::handle::HostSettingFuture {
        let app = self.0.clone();
        Box::pin(async move {
            let result = match (key.as_str(), value) {
                ("desktop.autostart", None) => serde_json::to_value(
                    crate::runtime::desktop_startup::desktop_autostart_get(app).await?,
                ),
                ("desktop.autostart", Some(value)) => serde_json::to_value(
                    crate::runtime::desktop_startup::desktop_autostart_set(app, decode(value)?)
                        .await?,
                ),
                ("desktop.exitOnClose", None) => {
                    serde_json::to_value(crate::desktop_tray::desktop_exit_on_close_get(app).await?)
                }
                ("desktop.exitOnClose", Some(value)) => serde_json::to_value(
                    crate::desktop_tray::desktop_exit_on_close_set(app, decode(value)?).await?,
                ),
                ("desktop.showShortcut", None) => {
                    serde_json::to_value(crate::desktop_shortcut::desktop_shortcut_get(app).await?)
                }
                ("desktop.showShortcut", Some(value)) => serde_json::to_value(
                    crate::desktop_shortcut::desktop_shortcut_set(app, decode(value)?).await?,
                ),
                _ => return Err("unknown desktop setting".to_owned()),
            };
            result.map_err(|_| "control result serialization failed".to_owned())
        })
    }

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

fn decode<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value)
        .map_err(|_| "invalid control value; consult settings list for the schema".to_owned())
}

pub(crate) fn shell(app: &AppHandle) -> Arc<dyn HostShell> {
    Arc::new(TauriHostShell(app.clone()))
}
