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
    app.try_state::<crate::runtime::Runtime>()
        .map(|runtime| Arc::clone(&runtime.host_events))
        .unwrap_or_else(|| Arc::new(TauriHostEvents(app.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::events::RuntimeEvent;

    #[test]
    fn runtime_channel_keeps_the_existing_unsequenced_envelope() {
        let received = Arc::new(std::sync::Mutex::new(Vec::new()));
        let messages = Arc::clone(&received);
        let channel = Channel::new(move |body| {
            messages
                .lock()
                .unwrap()
                .push(body.deserialize::<Value>().unwrap());
            Ok(())
        });
        let bus = RuntimeEventBus::default();
        bus.subscribe("main", channel.id(), Arc::new(TauriChannelEvents(channel)));
        bus.send(RuntimeEventEnvelope::session(
            "chat".into(),
            "project".into(),
            RuntimeEvent::AssistantTextDelta {
                generation: 1,
                delta: "text".into(),
            },
        ));
        assert_eq!(
            *received.lock().unwrap(),
            vec![
                serde_json::json!({"sessionKey":"chat", "projectId":"project", "type":"assistant_text_delta", "generation":1, "delta":"text"})
            ]
        );
    }
}
