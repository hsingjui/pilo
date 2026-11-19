use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::runtime::host_events::HostEvents;

struct TauriHostEvents(AppHandle);

impl HostEvents for TauriHostEvents {
    fn emit(&self, name: &str, payload: Value) -> Result<(), String> {
        self.0
            .emit(name, payload)
            .map_err(|error| error.to_string())
    }
}

pub(crate) fn from_app(app: &AppHandle) -> Arc<dyn HostEvents> {
    Arc::new(TauriHostEvents(app.clone()))
}
