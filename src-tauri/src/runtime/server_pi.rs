use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicU64, Ordering},
};

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::domain::{Connection, Project};

use super::{
    events::{PiProcessState, RuntimeErrorCode, RuntimeEvent, RuntimeEventSink, RuntimeLogStream},
    pi_events::PiEventAdapter,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager},
    session_snapshot::PiSessionSnapshot,
};

static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct StateCell(AtomicU8);

impl Default for StateCell {
    fn default() -> Self {
        Self(AtomicU8::new(state_to_u8(PiProcessState::Stopped)))
    }
}

impl StateCell {
    fn get(&self) -> PiProcessState {
        match self.0.load(Ordering::Acquire) {
            1 => PiProcessState::Starting,
            2 => PiProcessState::Running,
            3 => PiProcessState::Stopping,
            4 => PiProcessState::Failed,
            _ => PiProcessState::Stopped,
        }
    }

    fn set(&self, state: PiProcessState) {
        self.0.store(state_to_u8(state), Ordering::Release);
    }
}

const fn state_to_u8(state: PiProcessState) -> u8 {
    match state {
        PiProcessState::Stopped => 0,
        PiProcessState::Starting => 1,
        PiProcessState::Running => 2,
        PiProcessState::Stopping => 3,
        PiProcessState::Failed => 4,
    }
}

#[derive(Clone, Debug, Default)]
pub struct PiLaunchOptions {
    pub session_path: Option<String>,
    pub no_session: bool,
    pub disable_resources: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub system_prompt: Option<String>,
}

struct Launch {
    connection: Connection,
    project_id: Option<String>,
    project: String,
    options: PiLaunchOptions,
}

pub struct ServerPiSession {
    generation: u64,
    state: Arc<StateCell>,
    launch: Option<Launch>,
    client: Option<Arc<ServerClient>>,
    stream_id: Option<String>,
    event_task: Option<JoinHandle<()>>,
}

impl Default for ServerPiSession {
    fn default() -> Self {
        Self {
            generation: 0,
            state: Arc::new(StateCell::default()),
            launch: None,
            client: None,
            stream_id: None,
            event_task: None,
        }
    }
}

fn forward_pi_rpc<S: RuntimeEventSink>(
    adapter: &mut PiEventAdapter,
    sink: &S,
    generation: u64,
    data: Value,
) {
    let adapted = adapter.adapt(generation, &data);
    if data.get("type").and_then(Value::as_str) == Some("response") {
        sink.send(RuntimeEvent::RpcMessage {
            generation,
            message: data,
        });
    }
    for event in adapted {
        sink.send(event);
    }
}

impl ServerPiSession {
    pub fn snapshot(&self) -> PiSessionSnapshot {
        PiSessionSnapshot {
            generation: self.generation,
            state: self.state.get(),
            connection: self.launch.as_ref().map(|launch| launch.connection.clone()),
            project_id: self
                .launch
                .as_ref()
                .and_then(|launch| launch.project_id.clone()),
        }
    }

    pub async fn spawn<S: RuntimeEventSink>(
        &mut self,
        servers: Arc<ServerManager>,
        sink: S,
        project: &Project,
        options: PiLaunchOptions,
    ) -> Result<PiSessionSnapshot, String> {
        if matches!(
            self.state.get(),
            PiProcessState::Starting | PiProcessState::Running | PiProcessState::Stopping
        ) {
            return Err("Pi process is already active".to_owned());
        }

        let client = servers.client(&project.connection).await?;
        let generation = self.generation.saturating_add(1);
        self.generation = generation;
        self.state.set(PiProcessState::Starting);
        sink.send(RuntimeEvent::ProcessState {
            generation,
            state: PiProcessState::Starting,
        });

        let stream_id = format!(
            "pi-{}-{}",
            std::process::id(),
            STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let mut events = client.subscribe(&stream_id);
        let event_stream_id = stream_id.clone();
        let event_state = Arc::clone(&self.state);
        let event_sink = sink.clone();
        let event_client = Arc::clone(&client);
        let event_task = tokio::spawn(async move {
            let mut adapter = PiEventAdapter::default();
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        if matches!(
                            event_state.get(),
                            PiProcessState::Running | PiProcessState::Starting
                        ) {
                            event_state.set(PiProcessState::Failed);
                            event_sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::ProcessIo,
                                message: format!(
                                    "pilo-server Pi event stream overflowed and dropped {skipped} events"
                                ),
                            });
                            event_sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: PiProcessState::Failed,
                            });
                            let _ = event_client
                                .request("pi.stop", json!({ "streamId": event_stream_id }))
                                .await;
                        }
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        if matches!(
                            event_state.get(),
                            PiProcessState::Running | PiProcessState::Starting
                        ) {
                            event_state.set(PiProcessState::Failed);
                            event_sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::ProcessIo,
                                message: "pilo-server disconnected while Pi was running".to_owned(),
                            });
                            event_sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: PiProcessState::Failed,
                            });
                        }
                        break;
                    }
                };
                if event.event == SERVER_DISCONNECTED_EVENT {
                    if matches!(
                        event_state.get(),
                        PiProcessState::Running | PiProcessState::Starting
                    ) {
                        event_state.set(PiProcessState::Failed);
                        event_sink.send(RuntimeEvent::RuntimeError {
                            generation,
                            code: RuntimeErrorCode::ProcessIo,
                            message: event
                                .data
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("pilo-server disconnected while Pi was running")
                                .to_owned(),
                        });
                        event_sink.send(RuntimeEvent::ProcessState {
                            generation,
                            state: PiProcessState::Failed,
                        });
                    }
                    break;
                }
                if event.stream_id != event_stream_id {
                    continue;
                }
                match event.event.as_str() {
                    "pi.rpc" => {
                        forward_pi_rpc(&mut adapter, &event_sink, generation, event.data.clone());
                    }
                    "pi.rpc_json" => {
                        let Some(bytes) = event.binary.first() else {
                            event_sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::RpcFraming,
                                message: "pilo-server Pi RPC event had no JSON payload".to_owned(),
                            });
                            continue;
                        };
                        match serde_json::from_slice::<Value>(bytes) {
                            Ok(data) => forward_pi_rpc(&mut adapter, &event_sink, generation, data),
                            Err(error) => event_sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::RpcDecode,
                                message: format!("Pi stdout emitted invalid RPC JSON: {error}"),
                            }),
                        }
                    }
                    "pi.stderr" => {
                        if let Some(bytes) = event.binary.first() {
                            event_sink.send(RuntimeEvent::RuntimeLog {
                                generation,
                                stream: RuntimeLogStream::Stderr,
                                message: String::from_utf8_lossy(bytes).into_owned(),
                            });
                        }
                    }
                    "pi.error" => {
                        event_sink.send(RuntimeEvent::RuntimeError {
                            generation,
                            code: RuntimeErrorCode::ProcessIo,
                            message: event
                                .data
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Pi RPC stream failed")
                                .to_owned(),
                        });
                    }
                    "pi.stdout_closed" => {
                        if event_state.get() != PiProcessState::Stopping {
                            let success = event
                                .data
                                .get("success")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            let next_state = if success {
                                PiProcessState::Stopped
                            } else {
                                let code = event.data.get("code").and_then(Value::as_i64);
                                event_sink.send(RuntimeEvent::RuntimeError {
                                    generation,
                                    code: RuntimeErrorCode::ProcessIo,
                                    message: code.map_or_else(
                                        || "Pi RPC exited unexpectedly".to_owned(),
                                        |code| format!("Pi RPC exited with code {code}"),
                                    ),
                                });
                                PiProcessState::Failed
                            };
                            event_state.set(next_state);
                            event_sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: next_state,
                            });
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        if let Err(error) = client
            .request(
                "pi.start",
                json!({
                    "streamId": stream_id,
                    "project": project.path,
                    "sessionPath": options.session_path,
                    "noSession": options.no_session,
                    "disableResources": options.disable_resources,
                    "provider": options.provider,
                    "model": options.model,
                    "thinking": options.thinking,
                    "systemPrompt": options.system_prompt,
                }),
            )
            .await
        {
            event_task.abort();
            self.state.set(PiProcessState::Failed);
            sink.send(RuntimeEvent::RuntimeError {
                generation,
                code: RuntimeErrorCode::SpawnFailed,
                message: error.clone(),
            });
            sink.send(RuntimeEvent::ProcessState {
                generation,
                state: PiProcessState::Failed,
            });
            return Err(error);
        }

        self.state.set(PiProcessState::Running);
        sink.send(RuntimeEvent::ProcessState {
            generation,
            state: PiProcessState::Running,
        });
        self.launch = Some(Launch {
            connection: project.connection.clone(),
            project_id: Some(project.id.clone()),
            project: project.path.clone(),
            options: options.clone(),
        });
        self.client = Some(client);
        self.stream_id = Some(stream_id);
        self.event_task = Some(event_task);
        Ok(self.snapshot())
    }

    pub async fn send_rpc(&self, command: Value) -> Result<(), String> {
        if !command.is_object() {
            return Err("RPC command must be a JSON object".to_owned());
        }
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| "Pi process is not running".to_owned())?;
        let stream_id = self
            .stream_id
            .as_ref()
            .ok_or_else(|| "Pi process is not running".to_owned())?;
        client
            .request(
                "pi.send",
                json!({ "streamId": stream_id, "command": command }),
            )
            .await
            .map(|_| ())
    }

    pub async fn abort(&self) -> Result<(), String> {
        self.send_rpc(json!({ "type": "abort" })).await
    }

    pub async fn stop(&mut self) -> Result<PiSessionSnapshot, String> {
        let Some(client) = self.client.take() else {
            self.state.set(PiProcessState::Stopped);
            return Ok(self.snapshot());
        };
        let Some(stream_id) = self.stream_id.take() else {
            self.state.set(PiProcessState::Stopped);
            return Ok(self.snapshot());
        };
        self.state.set(PiProcessState::Stopping);
        let result = client
            .request("pi.stop", json!({ "streamId": stream_id }))
            .await;
        if let Some(task) = self.event_task.take() {
            task.abort();
        }
        self.state.set(if result.is_ok() {
            PiProcessState::Stopped
        } else {
            PiProcessState::Failed
        });
        result?;
        Ok(self.snapshot())
    }

    pub async fn restart<S: RuntimeEventSink>(
        &mut self,
        servers: Arc<ServerManager>,
        sink: S,
    ) -> Result<PiSessionSnapshot, String> {
        let launch = self
            .launch
            .as_ref()
            .ok_or_else(|| "no previous Pi launch configuration is available".to_owned())?;
        let project = Project {
            id: launch.project_id.clone().unwrap_or_default(),
            name: String::new(),
            path: launch.project.clone(),
            connection: launch.connection.clone(),
            metadata: crate::domain::ProjectMetadata {
                cwd: launch.project.clone(),
                git_branch: None,
                pi_version: String::new(),
                refreshed_at_ms: 0,
            },
            created_at_ms: 0,
            last_opened_at_ms: 0,
        };
        let options = launch.options.clone();
        let _ = self.stop().await;
        self.spawn(servers, sink, &project, options).await
    }
}
