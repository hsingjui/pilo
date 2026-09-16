use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicU64, Ordering},
};

use serde_json::{Value, json};
use tokio::{
    task::JoinHandle,
    time::{Duration, MissedTickBehavior},
};

use crate::domain::{Connection, Project};

use super::{
    debug_trace::runtime_trace,
    events::{PiProcessState, RuntimeErrorCode, RuntimeEvent, RuntimeEventSink, RuntimeLogStream},
    pi_events::PiEventAdapter,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager},
    session_snapshot::PiSessionSnapshot,
};

static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const RUNTIME_EVENT_BATCH_MS: u64 = 16;
const MAX_BUFFERED_RUNTIME_EVENTS: usize = 128;

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

fn trace_pi_transport_event(stream_id: &str, data: &Value) {
    let Some(event_type) = data.get("type").and_then(Value::as_str) else {
        return;
    };
    if !matches!(
        event_type,
        "response"
            | "agent_start"
            | "agent_end"
            | "agent_settled"
            | "turn_start"
            | "turn_end"
            | "message_start"
            | "message_end"
            | "tool_execution_start"
            | "tool_execution_end"
            | "queue_update"
            | "compaction_start"
            | "compaction_end"
            | "auto_retry_start"
            | "auto_retry_end"
    ) {
        return;
    }
    runtime_trace(
        "server_pi.recv",
        None,
        Some(stream_id),
        json!({
            "event": event_type,
            "id": data.get("id"),
            "command": data.get("command"),
            "success": data.get("success"),
            "role": data.pointer("/message/role"),
            "stopReason": data.pointer("/message/stopReason"),
            "willRetry": data.get("willRetry"),
            "toolCallId": data.get("toolCallId"),
            "toolName": data.get("toolName"),
        }),
    );
}

fn adapt_pi_rpc(adapter: &mut PiEventAdapter, generation: u64, data: Value) -> Vec<RuntimeEvent> {
    let adapted = adapter.adapt(generation, &data);
    let mut events = Vec::new();
    if data.get("type").and_then(Value::as_str) == Some("response") {
        events.push(RuntimeEvent::RpcMessage {
            generation,
            message: data,
        });
    }
    events.extend(adapted);

    events
}

fn push_coalesced_runtime_event(buffer: &mut Vec<RuntimeEvent>, event: RuntimeEvent) {
    match event {
        RuntimeEvent::AssistantTextDelta { generation, delta } => {
            if let Some(RuntimeEvent::AssistantTextDelta {
                generation: previous_generation,
                delta: previous_delta,
            }) = buffer.last_mut()
                && *previous_generation == generation
            {
                previous_delta.push_str(&delta);
                return;
            }
            buffer.push(RuntimeEvent::AssistantTextDelta { generation, delta });
        }
        RuntimeEvent::AssistantThinkingDelta { generation, delta } => {
            if let Some(RuntimeEvent::AssistantThinkingDelta {
                generation: previous_generation,
                delta: previous_delta,
            }) = buffer.last_mut()
                && *previous_generation == generation
            {
                previous_delta.push_str(&delta);
                return;
            }
            buffer.push(RuntimeEvent::AssistantThinkingDelta { generation, delta });
        }
        RuntimeEvent::ToolExecutionUpdate {
            generation,
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => {
            if let Some(RuntimeEvent::ToolExecutionUpdate {
                generation: previous_generation,
                tool_call_id: previous_tool_call_id,
                tool_name: previous_tool_name,
                args: previous_args,
                partial_result: previous_partial_result,
            }) = buffer.last_mut()
                && *previous_generation == generation
                && *previous_tool_call_id == tool_call_id
            {
                *previous_tool_name = tool_name;
                *previous_args = args;
                *previous_partial_result = partial_result;
                return;
            }
            buffer.push(RuntimeEvent::ToolExecutionUpdate {
                generation,
                tool_call_id,
                tool_name,
                args,
                partial_result,
            });
        }
        other => buffer.push(other),
    }
}

fn flush_runtime_events<S: RuntimeEventSink>(sink: &S, buffer: &mut Vec<RuntimeEvent>) {
    for event in buffer.drain(..) {
        sink.send(event);
    }
}

fn dispatch_runtime_event<S: RuntimeEventSink>(
    sink: &S,
    buffer: &mut Vec<RuntimeEvent>,
    event: RuntimeEvent,
) {
    let buffered = matches!(
        event,
        RuntimeEvent::AssistantTextDelta { .. }
            | RuntimeEvent::AssistantThinkingDelta { .. }
            | RuntimeEvent::ToolExecutionUpdate { .. }
    );
    if buffered {
        push_coalesced_runtime_event(buffer, event);
        if buffer.len() >= MAX_BUFFERED_RUNTIME_EVENTS {
            flush_runtime_events(sink, buffer);
        }
        return;
    }

    flush_runtime_events(sink, buffer);
    sink.send(event);
}

fn dispatch_runtime_events<S: RuntimeEventSink>(
    sink: &S,
    buffer: &mut Vec<RuntimeEvent>,
    events: impl IntoIterator<Item = RuntimeEvent>,
) {
    for event in events {
        dispatch_runtime_event(sink, buffer, event);
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
        let mut events = client.subscribe(&stream_id);
        let event_stream_id = stream_id.clone();
        let event_state = Arc::clone(&self.state);
        let event_sink = sink.clone();
        let event_task = tokio::spawn(async move {
            let mut adapter = PiEventAdapter::default();
            let mut buffered_runtime_events = Vec::new();
            let mut flush_tick =
                tokio::time::interval(Duration::from_millis(RUNTIME_EVENT_BATCH_MS));
            flush_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            // `interval` fires immediately on its first tick. Consume that tick so
            // the first streamed delta gets a real coalescing window.
            flush_tick.tick().await;
            loop {
                let received = tokio::select! {
                    _ = flush_tick.tick() => {
                        flush_runtime_events(&event_sink, &mut buffered_runtime_events);
                        continue;
                    }
                    event = events.recv() => event,
                };
                let Some(event) = received else {
                    flush_runtime_events(&event_sink, &mut buffered_runtime_events);
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
                };
                if event.event == SERVER_DISCONNECTED_EVENT {
                    flush_runtime_events(&event_sink, &mut buffered_runtime_events);
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
                        let data = event.data.clone();
                        trace_pi_transport_event(&event_stream_id, &data);
                        dispatch_runtime_events(
                            &event_sink,
                            &mut buffered_runtime_events,
                            adapt_pi_rpc(&mut adapter, generation, data),
                        );
                    }
                    "pi.rpc_json" => {
                        let Some(bytes) = event.binary.first() else {
                            flush_runtime_events(&event_sink, &mut buffered_runtime_events);
                            event_sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::RpcFraming,
                                message: "pilo-server Pi RPC event had no JSON payload".to_owned(),
                            });
                            continue;
                        };
                        match serde_json::from_slice::<Value>(bytes) {
                            Ok(data) => {
                                trace_pi_transport_event(&event_stream_id, &data);
                                dispatch_runtime_events(
                                    &event_sink,
                                    &mut buffered_runtime_events,
                                    adapt_pi_rpc(&mut adapter, generation, data),
                                );
                            }
                            Err(error) => {
                                flush_runtime_events(&event_sink, &mut buffered_runtime_events);
                                event_sink.send(RuntimeEvent::RuntimeError {
                                    generation,
                                    code: RuntimeErrorCode::RpcDecode,
                                    message: format!("Pi stdout emitted invalid RPC JSON: {error}"),
                                });
                            }
                        }
                    }
                    "pi.stderr" => {
                        if let Some(bytes) = event.binary.first() {
                            dispatch_runtime_event(
                                &event_sink,
                                &mut buffered_runtime_events,
                                RuntimeEvent::RuntimeLog {
                                    generation,
                                    stream: RuntimeLogStream::Stderr,
                                    message: String::from_utf8_lossy(bytes).into_owned(),
                                },
                            );
                        }
                    }
                    "pi.error" => {
                        dispatch_runtime_event(
                            &event_sink,
                            &mut buffered_runtime_events,
                            RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::ProcessIo,
                                message: event
                                    .data
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Pi RPC stream failed")
                                    .to_owned(),
                            },
                        );
                    }
                    "pi.stdout_closed" => {
                        flush_runtime_events(&event_sink, &mut buffered_runtime_events);
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
            flush_runtime_events(&event_sink, &mut buffered_runtime_events);
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
                    "piExecutable": project.connection.pi_executable,
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

    use super::{RuntimeEvent, push_coalesced_runtime_event};

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
