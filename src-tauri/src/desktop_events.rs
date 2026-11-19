use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::runtime::events::{RuntimeEventBus, RuntimeEventEnvelope, TauriEventSink};
use crate::runtime::host_events::HostEvents;
use tauri::{Manager, ipc::Channel};

pub(crate) struct TauriChannelEvents(pub(crate) Channel<RuntimeEventEnvelope>);

impl HostEvents for TauriChannelEvents {
    fn emit(&self, _name: &str, _payload: Value) -> Result<(), String> {
        Err("runtime channel requires a runtime event envelope".to_owned())
    }

    fn emit_runtime(&self, event: RuntimeEventEnvelope) -> Result<(), String> {
        self.0.send(event).map_err(|error| error.to_string())
    }
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self::from_bus(app.state::<RuntimeEventBus>().inner().clone())
    }
}

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
