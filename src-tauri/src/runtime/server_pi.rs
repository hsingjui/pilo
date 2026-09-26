use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicU64, Ordering},
};

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::domain::{Connection, Project};

use super::{
    events::{PiProcessState, RuntimeErrorCode, RuntimeEvent, RuntimeEventSink},
    server_client::{ServerClient, ServerManager},
    session_snapshot::PiSessionSnapshot,
};

static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);

mod event_stream;

use event_stream::spawn_event_task;
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
    pub disable_builtin_tools: bool,
    pub disable_extension_discovery: bool,
    pub disable_context_files: bool,
    pub extensions: Vec<String>,
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

impl ServerPiSession {
    pub fn stream_id(&self) -> Option<&str> {
        self.stream_id.as_deref()
    }

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
        let event_task = spawn_event_task(
            Arc::clone(&client),
            sink.clone(),
            Arc::clone(&self.state),
            stream_id.clone(),
            generation,
        );

        if let Err(error) = client
            .request(
                "pi.start",
                json!({
                    "streamId": stream_id,
                    "project": project.path,
                    "sessionPath": options.session_path,
                    "noSession": options.no_session,
                    "disableResources": options.disable_resources,
                    "extensions": options.extensions,
                    "provider": options.provider,
                    "model": options.model,
                    "thinking": options.thinking,
                    "systemPrompt": options.system_prompt,
                    "piExecutable": project.connection.pi_executable,
                    "disableBuiltinTools": options.disable_builtin_tools,
                    "disableExtensionDiscovery": options.disable_extension_discovery,
                    "disableContextFiles": options.disable_context_files,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::server_pi_events::push_coalesced_runtime_event;
    use super::RuntimeEvent;

    #[test]
    fn coalesces_adjacent_text_and_thinking_deltas() {
        let mut events = Vec::new();
        push_coalesced_runtime_event(
            &mut events,
            RuntimeEvent::AssistantTextDelta {
                generation: 3,
                delta: "hel".to_owned(),
            },
        );
        push_coalesced_runtime_event(
            &mut events,
            RuntimeEvent::AssistantTextDelta {
                generation: 3,
                delta: "lo".to_owned(),
            },
        );
        push_coalesced_runtime_event(
            &mut events,
            RuntimeEvent::AssistantThinkingDelta {
                generation: 3,
                delta: "a".to_owned(),
            },
        );
        push_coalesced_runtime_event(
            &mut events,
            RuntimeEvent::AssistantThinkingDelta {
                generation: 3,
                delta: "b".to_owned(),
            },
        );

        assert_eq!(
            events,
            vec![
                RuntimeEvent::AssistantTextDelta {
                    generation: 3,
                    delta: "hello".to_owned(),
                },
                RuntimeEvent::AssistantThinkingDelta {
                    generation: 3,
                    delta: "ab".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn keeps_only_latest_adjacent_tool_update() {
        let mut events = Vec::new();
        push_coalesced_runtime_event(
            &mut events,
            RuntimeEvent::ToolExecutionUpdate {
                generation: 5,
                tool_call_id: "call-1".to_owned(),
                tool_name: "read".to_owned(),
                args: json!({ "path": "a" }),
                partial_result: json!({ "content": "first" }),
            },
        );
        push_coalesced_runtime_event(
            &mut events,
            RuntimeEvent::ToolExecutionUpdate {
                generation: 5,
                tool_call_id: "call-1".to_owned(),
                tool_name: "read".to_owned(),
                args: json!({ "path": "a" }),
                partial_result: json!({ "content": "latest" }),
            },
        );

        assert_eq!(
            events,
            vec![RuntimeEvent::ToolExecutionUpdate {
                generation: 5,
                tool_call_id: "call-1".to_owned(),
                tool_name: "read".to_owned(),
                args: json!({ "path": "a" }),
                partial_result: json!({ "content": "latest" }),
            }]
        );
    }
}
