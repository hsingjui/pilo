use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
};

use pilo_protocol::BuiltinExtension;
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
struct StateCell {
    process: AtomicU8,
    next_prompt_ready: AtomicBool,
    cache_keep_alive: StdMutex<Option<crate::domain::CacheKeepAliveStatus>>,
    control: StdMutex<Vec<super::control::ControlLease>>,
}

impl Default for StateCell {
    fn default() -> Self {
        Self {
            process: AtomicU8::new(state_to_u8(PiProcessState::Stopped)),
            next_prompt_ready: AtomicBool::new(false),
            cache_keep_alive: StdMutex::new(None),
            control: StdMutex::new(Vec::new()),
        }
    }
}

impl StateCell {
    fn get(&self) -> PiProcessState {
        match self.process.load(Ordering::Acquire) {
            1 => PiProcessState::Starting,
            2 => PiProcessState::Running,
            3 => PiProcessState::Stopping,
            4 => PiProcessState::Failed,
            _ => PiProcessState::Stopped,
        }
    }

    fn set(&self, state: PiProcessState) {
        self.process.store(state_to_u8(state), Ordering::Release);
        if !matches!(state, PiProcessState::Running | PiProcessState::Starting) {
            self.control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
        }
        if state != PiProcessState::Running {
            self.next_prompt_ready.store(false, Ordering::Release);
            *self
                .cache_keep_alive
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        }
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
    pub builtin_extensions: Vec<BuiltinExtension>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub system_prompt: Option<String>,
    pub agent_control: bool,
}

struct Launch {
    connection: Connection,
    project_id: Option<String>,
    project: String,
    options: PiLaunchOptions,
}

#[derive(Clone)]
pub(crate) struct SessionSnapshotReader {
    metadata: Arc<StdMutex<PiSessionSnapshot>>,
    state: Arc<StateCell>,
}

impl SessionSnapshotReader {
    pub(crate) fn cache_keep_alive(&self) -> Option<crate::domain::CacheKeepAliveStatus> {
        self.state
            .cache_keep_alive
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn snapshot(&self) -> PiSessionSnapshot {
        let mut snapshot = self
            .metadata
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        snapshot.state = self.state.get();
        snapshot
    }
}

pub struct ServerPiSession {
    builtin_extensions: Vec<BuiltinExtension>,
    generation: u64,
    snapshot_metadata: Arc<StdMutex<PiSessionSnapshot>>,
    state: Arc<StateCell>,
    launch: Option<Launch>,
    client: Option<Arc<ServerClient>>,
    stream_id: Option<String>,
    event_task: Option<JoinHandle<()>>,
}

impl Default for ServerPiSession {
    fn default() -> Self {
        Self::with_builtin_extensions(Vec::new())
    }
}

async fn stop_stream(client: &ServerClient, stream_id: &str) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match client
                .request("pi.stop", json!({ "streamId": stream_id }))
                .await
            {
                Err(error) if error.contains("request capacity exhausted") => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                result => return result.map(|_| ()),
            }
        }
    })
    .await
    .map_err(|_| "timed out while stopping Pi stream".to_owned())?
}

impl Drop for ServerPiSession {
    fn drop(&mut self) {
        self.schedule_cleanup();
    }
}

impl ServerPiSession {
    pub(crate) fn with_builtin_extensions(builtin_extensions: Vec<BuiltinExtension>) -> Self {
        Self {
            builtin_extensions,
            generation: 0,
            snapshot_metadata: Arc::new(StdMutex::new(PiSessionSnapshot {
                generation: 0,
                state: PiProcessState::Stopped,
                connection: None,
                project_id: None,
            })),
            state: Arc::new(StateCell::default()),
            launch: None,
            client: None,
            stream_id: None,
            event_task: None,
        }
    }

    pub(crate) fn cache_keep_alive_ready(&self) -> bool {
        self.state
            .cache_keep_alive
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_some_and(|status| status.ready)
    }

    pub(crate) fn builtin_extensions(&self) -> &[BuiltinExtension] {
        &self.builtin_extensions
    }

    pub(crate) fn next_prompt_ready(&self) -> bool {
        self.state.next_prompt_ready.load(Ordering::Acquire)
    }

    fn schedule_cleanup(&mut self) {
        self.state
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        if let Some(task) = self.event_task.take() {
            task.abort();
        }
        let Some(client) = self.client.take() else {
            return;
        };
        let Some(stream_id) = self.stream_id.take() else {
            return;
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    if let Err(error) = stop_stream(&client, &stream_id).await {
                        log::warn!(target: "pilo-server", "failed to clean up Pi stream '{stream_id}': {error}");
                    }
                });
            }
            Err(error) => {
                log::warn!(target: "pilo-server", "Pi stream cleanup has no runtime: {error}")
            }
        }
    }

    pub fn stream_id(&self) -> Option<&str> {
        self.stream_id.as_deref()
    }

    pub(crate) fn snapshot_reader(&self) -> SessionSnapshotReader {
        SessionSnapshotReader {
            metadata: Arc::clone(&self.snapshot_metadata),
            state: Arc::clone(&self.state),
        }
    }

    pub fn snapshot(&self) -> PiSessionSnapshot {
        self.snapshot_reader().snapshot()
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

        self.builtin_extensions = options.builtin_extensions.clone();
        // A failed generation may still own a server stream. Do not overwrite it.
        self.schedule_cleanup();
        let client = servers.client(&project.connection).await?;
        let generation = self.generation.saturating_add(1);
        self.generation = generation;
        *self
            .snapshot_metadata
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = PiSessionSnapshot {
            generation,
            state: PiProcessState::Starting,
            connection: Some(project.connection.clone()),
            project_id: Some(project.id.clone()),
        };
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

        self.client = Some(Arc::clone(&client));
        self.stream_id = Some(stream_id.clone());
        self.event_task = Some(event_task);
        let setup: Result<(Option<String>, Option<pilo_protocol::ControlContext>), String> =
            async {
                let mut control_stream = None;
                let mut remote_control = None;
                if options.agent_control {
                    let app = servers.control_app()?;
                    let control_id = format!("control:{stream_id}");
                    let (_, lease) = super::control::attach(
                        app.clone(),
                        client.clone(),
                        control_id.clone(),
                        &project.id,
                        matches!(
                            project.connection.kind,
                            crate::domain::ConnectionKind::Local
                        ),
                    )
                    .await?;
                    self.state
                        .control
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(lease);
                    control_stream = Some(control_id);
                    if options
                        .builtin_extensions
                        .iter()
                        .any(|extension| matches!(extension, BuiltinExtension::SshWorkspace { .. }))
                    {
                        let original = super::project::get(&app, &project.id)?;
                        let remote_client = servers.client(&original.connection).await?;
                        let (context, lease) = super::control::attach(
                            app,
                            remote_client,
                            format!("remote-control:{stream_id}"),
                            &project.id,
                            false,
                        )
                        .await?;
                        self.state
                            .control
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(lease);
                        remote_control = Some(context);
                    }
                }

                Ok((control_stream, remote_control))
            }
            .await;
        let (control_stream, remote_control) = match setup {
            Ok(context) => context,
            Err(error) => {
                let _ = self.stop().await;
                self.schedule_cleanup();
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
        };

        // Record ownership before awaiting the acknowledgement, so cancellation
        // and a lost pi.start response still have a stream to clean up.
        if let Err(error) = client
            .request(
                "pi.start",
                json!({
                    "streamId": stream_id,
                    "controlStreamId": control_stream,
                    "remoteControl": remote_control,
                    "project": project.path,
                    "sessionPath": options.session_path,
                    "noSession": options.no_session,
                    "disableResources": options.disable_resources,
                    "extensions": options.extensions,
                    "builtinExtensions": options.builtin_extensions,
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
            if let Err(stop_error) = self.stop().await {
                log::warn!(target: "pilo-server", "failed to roll back Pi startup: {stop_error}");
                self.schedule_cleanup();
            }
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
        let Some(client) = self.client.as_ref() else {
            self.state.set(PiProcessState::Stopped);
            return Ok(self.snapshot());
        };
        let Some(stream_id) = self.stream_id.as_ref() else {
            self.state.set(PiProcessState::Stopped);
            return Ok(self.snapshot());
        };
        self.state.set(PiProcessState::Stopping);
        let result = stop_stream(client, stream_id).await;
        if let Some(task) = self.event_task.take() {
            task.abort();
        }
        self.state.set(if result.is_ok() {
            PiProcessState::Stopped
        } else {
            PiProcessState::Failed
        });
        result?;
        self.client = None;
        self.stream_id = None;
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
