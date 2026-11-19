//! M0 spike: the runtime's AppHandle-free entry points, for the nsh shell
//! (`desktop/native`). Everything here delegates to the code the Tauri
//! commands and the Remote API already call; M1 replaces this module with
//! the extracted runtime's own API.

use std::{path::PathBuf, sync::Arc, time::Duration};

use serde_json::{Value, json};

use super::{
    PiloRuntime, RuntimeEventBus,
    chat_service::{self, ChatSessionRequest},
    events::{RuntimeEvent, RuntimeEventEnvelope},
    host_paths::HostPaths,
    storage,
};

/// A Pilo host without a Tauri app: the data directory, the runtime and
/// its event bus.
pub struct SpikeHost {
    paths: HostPaths,
    runtime: Arc<PiloRuntime>,
    events: RuntimeEventBus,
}

impl SpikeHost {
    /// Opens the host on `app_data_dir`; Local connections run
    /// `server_binary` as their `pilo-server`.
    pub fn open(app_data_dir: PathBuf, server_binary: PathBuf) -> Result<Self, String> {
        super::initialize_local_server_binary(server_binary);
        let paths = HostPaths::new(app_data_dir, PathBuf::new())?;
        storage::open_with_paths(&paths)?;
        let runtime = Arc::new(PiloRuntime::default());
        // Agent control attaches through the Tauri app (`runtime::control`).
        runtime.servers.disable_agent_control();
        Ok(Self {
            paths,
            runtime,
            events: RuntimeEventBus::default(),
        })
    }

    /// The projects of the data directory, as the JSON the frontend reads.
    pub fn projects(&self) -> Result<Value, String> {
        let db = storage::open_with_paths(&self.paths)?;
        serde_json::to_value(storage::list_projects(&db)?).map_err(|error| error.to_string())
    }

    /// The indexed sessions of a project, newest first.
    pub fn sessions(&self, project_id: &str) -> Result<Value, String> {
        let db = storage::open_with_paths(&self.paths)?;
        serde_json::to_value(storage::list_sessions(&db, project_id)?)
            .map_err(|error| error.to_string())
    }

    /// Starts (or attaches to) the chat `session_key` of a project.
    pub async fn start_chat(
        &self,
        project_id: &str,
        session_key: &str,
        session_path: Option<String>,
    ) -> Result<Value, String> {
        let snapshot = chat_service::start(
            &self.paths,
            &self.runtime,
            self.events.clone(),
            ChatSessionRequest {
                project_id: project_id.to_owned(),
                session_key: session_key.to_owned(),
                session_path,
                no_session: false,
                extensions: Vec::new(),
                builtin_extensions: Vec::new(),
            },
        )
        .await?;
        serde_json::to_value(snapshot).map_err(|error| error.to_string())
    }

    /// Sends a prompt to a started chat.
    pub async fn prompt(&self, session_key: &str, message: &str) -> Result<(), String> {
        self.runtime
            .chat_sessions
            .send(session_key, json!({ "type": "prompt", "message": message }))
            .await
    }

    /// Stops a chat's Pi process.
    pub async fn stop_chat(&self, session_key: &str) -> Result<(), String> {
        self.runtime
            .chat_sessions
            .stop(session_key, Some("nsh_spike"))
            .await
    }

    /// Publishes one assistant message of `count` text deltas on the event
    /// bus, `per_second` of them a second: the load of a fast model, for
    /// measuring the shell's delivery and rendering.
    pub async fn emit_text_burst(
        &self,
        session_key: &str,
        project_id: &str,
        count: u32,
        per_second: u32,
    ) {
        let send = |event| {
            self.events.send(RuntimeEventEnvelope::session(
                session_key.to_owned(),
                project_id.to_owned(),
                event,
            ));
        };
        let generation = 1;
        send(RuntimeEvent::AssistantMessageStart { generation });
        let mut ticks = tokio::time::interval(Duration::from_secs(1) / per_second.max(1));
        for index in 0..count {
            ticks.tick().await;
            send(RuntimeEvent::AssistantTextDelta {
                generation,
                delta: format!("token{index} "),
            });
        }
        send(RuntimeEvent::AssistantMessageEnd {
            generation,
            stop_reason: Some("stop".to_owned()),
            error_message: None,
            usage: None,
        });
    }

    /// The runtime's events from now on, each as the JSON the frontend
    /// reads (`sequence`, `sessionKey`, `type`, ...).
    pub fn events(&self) -> SpikeEvents {
        SpikeEvents {
            receiver: self.events.subscribe_web(),
        }
    }
}

/// A subscription to the runtime's events.
pub struct SpikeEvents {
    receiver: super::events::WebEventReceiver,
}

impl SpikeEvents {
    /// The next event; `None` once the bus is gone. Events dropped because
    /// the subscriber fell behind are reported as `{"type":"lagged"}`.
    pub async fn next(&mut self) -> Option<Value> {
        use tokio::sync::broadcast::error::RecvError;
        match self.receiver.recv().await {
            Ok(event) => serde_json::to_value(&*event).ok(),
            Err(RecvError::Lagged(skipped)) => {
                Some(json!({ "type": "lagged", "skipped": skipped }))
            }
            Err(RecvError::Closed) => None,
        }
    }
}
