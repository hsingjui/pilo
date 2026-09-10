use std::{
    io,
    sync::atomic::{AtomicU64, AtomicU8, Ordering},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use crate::domain::Connection;

use super::{
    events::{PiProcessState, RuntimeErrorCode, RuntimeEvent, RuntimeEventSink, RuntimeLogStream},
    pi_events::PiEventAdapter,
    process::{ManagedProcess, ProcessSpec},
    rpc::{JsonlCodec, RpcCodecError},
};

const PROCESS_COMMAND_CAPACITY: usize = 32;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("Pi process is already active")]
    AlreadyRunning,
    #[error("Pi process is not running")]
    NotRunning,
    #[error("no previous Pi launch configuration is available")]
    NoPreviousLaunch,
    #[error("RPC command must be a JSON object")]
    InvalidRpcCommand,
    #[error("failed to spawn Pi process: {0}")]
    Spawn(#[source] io::Error),
    #[error("failed to encode RPC command: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("Pi process control channel is closed")]
    ControlClosed,
    #[error("Pi process I/O failed: {0}")]
    ProcessIo(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionSnapshot {
    pub generation: u64,
    pub state: PiProcessState,
    pub connection: Option<Connection>,
    pub workspace_id: Option<String>,
}

#[derive(Default)]
struct GenerationClock {
    next: AtomicU64,
    active: AtomicU64,
}

impl GenerationClock {
    fn activate_next(&self) -> u64 {
        let generation = self.next.fetch_add(1, Ordering::AcqRel) + 1;
        self.active.store(generation, Ordering::Release);
        generation
    }

    fn last(&self) -> u64 {
        self.next.load(Ordering::Acquire)
    }

    fn is_current(&self, generation: u64) -> bool {
        generation != 0 && self.active.load(Ordering::Acquire) == generation
    }

    fn deactivate(&self, generation: u64) -> bool {
        self.active
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

struct ProcessStateCell(AtomicU8);

impl Default for ProcessStateCell {
    fn default() -> Self {
        Self(AtomicU8::new(state_to_u8(PiProcessState::Stopped)))
    }
}

impl ProcessStateCell {
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

#[derive(Clone)]
struct LaunchConfig {
    connection: Connection,
    workspace_id: Option<String>,
    process: ProcessSpec,
}

struct ProcessControl {
    generation: u64,
    sender: mpsc::Sender<ProcessCommand>,
}

enum ProcessCommand {
    Write {
        data: Vec<u8>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Stop {
        reply: oneshot::Sender<Result<(), String>>,
    },
}

pub struct PiSession {
    generations: Arc<GenerationClock>,
    process_state: Arc<ProcessStateCell>,
    control: Option<ProcessControl>,
    launch: Option<LaunchConfig>,
}

impl Default for PiSession {
    fn default() -> Self {
        Self {
            generations: Arc::new(GenerationClock::default()),
            process_state: Arc::new(ProcessStateCell::default()),
            control: None,
            launch: None,
        }
    }
}

impl PiSession {
    pub fn snapshot(&self) -> PiSessionSnapshot {
        PiSessionSnapshot {
            generation: self.generations.last(),
            state: self.process_state.get(),
            connection: self.launch.as_ref().map(|launch| launch.connection.clone()),
            workspace_id: self
                .launch
                .as_ref()
                .and_then(|launch| launch.workspace_id.clone()),
        }
    }

    pub async fn spawn<S: RuntimeEventSink>(
        &mut self,
        sink: S,
        connection: Connection,
        workspace_id: Option<String>,
        process_spec: ProcessSpec,
    ) -> Result<PiSessionSnapshot, RuntimeError> {
        self.prune_finished_control();
        if matches!(
            self.process_state.get(),
            PiProcessState::Starting | PiProcessState::Running | PiProcessState::Stopping
        ) {
            return Err(RuntimeError::AlreadyRunning);
        }

        let generation = self.generations.activate_next();
        self.process_state.set(PiProcessState::Starting);
        sink.send(RuntimeEvent::ProcessState {
            generation,
            state: PiProcessState::Starting,
        });

        let launch = LaunchConfig {
            connection,
            workspace_id,
            process: process_spec,
        };
        let process_result = ManagedProcess::spawn(&launch.process);
        let stdout_ready_marker = launch.process.stdout_ready_marker.clone();
        self.launch = Some(launch);
        let process = match process_result {
            Ok(process) => process,
            Err(error) => {
                self.generations.deactivate(generation);
                self.process_state.set(PiProcessState::Failed);
                sink.send(RuntimeEvent::RuntimeError {
                    generation,
                    code: RuntimeErrorCode::SpawnFailed,
                    message: error.to_string(),
                });
                sink.send(RuntimeEvent::ProcessState {
                    generation,
                    state: PiProcessState::Failed,
                });
                return Err(RuntimeError::Spawn(error));
            }
        };

        let (child, stdin, stdout, stderr) = process.into_parts();
        let (sender, receiver) = mpsc::channel(PROCESS_COMMAND_CAPACITY);
        self.control = Some(ProcessControl { generation, sender });
        self.process_state.set(PiProcessState::Running);
        sink.send(RuntimeEvent::ProcessState {
            generation,
            state: PiProcessState::Running,
        });

        let stdout_task = tokio::spawn(read_stdout(
            stdout,
            generation,
            Arc::clone(&self.generations),
            sink.clone(),
            stdout_ready_marker,
        ));
        let stderr_task = tokio::spawn(read_stderr(
            stderr,
            generation,
            Arc::clone(&self.generations),
            sink.clone(),
        ));
        tokio::spawn(run_process(
            child,
            stdin,
            receiver,
            stdout_task,
            stderr_task,
            generation,
            Arc::clone(&self.generations),
            Arc::clone(&self.process_state),
            sink,
        ));

        Ok(self.snapshot())
    }

    pub async fn stop(&mut self) -> Result<PiSessionSnapshot, RuntimeError> {
        self.prune_finished_control();
        if !matches!(
            self.process_state.get(),
            PiProcessState::Starting | PiProcessState::Running | PiProcessState::Stopping
        ) {
            self.control = None;
            return Ok(self.snapshot());
        }

        let Some(control) = self.control.take() else {
            return Err(RuntimeError::ControlClosed);
        };
        let (reply, response) = oneshot::channel();
        control
            .sender
            .send(ProcessCommand::Stop { reply })
            .await
            .map_err(|_| RuntimeError::ControlClosed)?;
        match response.await {
            Ok(result) => result.map_err(RuntimeError::ProcessIo)?,
            Err(_)
                if matches!(
                    self.process_state.get(),
                    PiProcessState::Stopped | PiProcessState::Failed
                ) => {}
            Err(_) => return Err(RuntimeError::ControlClosed),
        }

        Ok(self.snapshot())
    }

    pub async fn restart<S: RuntimeEventSink>(
        &mut self,
        sink: S,
    ) -> Result<PiSessionSnapshot, RuntimeError> {
        let launch = self.launch.clone().ok_or(RuntimeError::NoPreviousLaunch)?;
        self.stop().await?;
        self.spawn(sink, launch.connection, launch.workspace_id, launch.process)
            .await
    }

    pub async fn abort(&self) -> Result<(), RuntimeError> {
        self.send_rpc(serde_json::json!({ "type": "abort" })).await
    }

    pub async fn send_rpc(&self, command: Value) -> Result<(), RuntimeError> {
        if !command.is_object() {
            return Err(RuntimeError::InvalidRpcCommand);
        }
        if self.process_state.get() != PiProcessState::Running {
            return Err(RuntimeError::NotRunning);
        }

        let Some(control) = &self.control else {
            return Err(RuntimeError::ControlClosed);
        };
        if !self.generations.is_current(control.generation) {
            return Err(RuntimeError::NotRunning);
        }

        let mut data = serde_json::to_vec(&command)?;
        data.push(b'\n');
        let (reply, response) = oneshot::channel();
        control
            .sender
            .send(ProcessCommand::Write { data, reply })
            .await
            .map_err(|_| RuntimeError::ControlClosed)?;
        response
            .await
            .map_err(|_| RuntimeError::ControlClosed)?
            .map_err(RuntimeError::ProcessIo)
    }

    fn prune_finished_control(&mut self) {
        if matches!(
            self.process_state.get(),
            PiProcessState::Stopped | PiProcessState::Failed
        ) {
            self.control = None;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_process<S: RuntimeEventSink>(
    mut child: Child,
    mut stdin: ChildStdin,
    mut receiver: mpsc::Receiver<ProcessCommand>,
    stdout_task: JoinHandle<()>,
    stderr_task: JoinHandle<()>,
    generation: u64,
    generations: Arc<GenerationClock>,
    process_state: Arc<ProcessStateCell>,
    sink: S,
) {
    let mut stdout_task = Some(stdout_task);
    let mut stderr_task = Some(stderr_task);

    loop {
        tokio::select! {
            wait_result = child.wait() => {
                await_reader(&mut stdout_task).await;
                await_reader(&mut stderr_task).await;
                if generations.deactivate(generation) {
                    match wait_result {
                        Ok(status) if status.success() => {
                            process_state.set(PiProcessState::Stopped);
                            sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: PiProcessState::Stopped,
                            });
                        }
                        Ok(status) => {
                            process_state.set(PiProcessState::Failed);
                            sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::ProcessExit,
                                message: format!("Pi process exited with status {status}"),
                            });
                            sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: PiProcessState::Failed,
                            });
                        }
                        Err(error) => {
                            process_state.set(PiProcessState::Failed);
                            sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::ProcessWait,
                                message: error.to_string(),
                            });
                            sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: PiProcessState::Failed,
                            });
                        }
                    }
                }
                break;
            }
            command = receiver.recv() => {
                match command {
                    Some(ProcessCommand::Write { data, reply }) => {
                        let result = write_stdin(&mut stdin, &data).await;
                        if let Err(message) = &result {
                            send_if_current(
                                &generations,
                                &sink,
                                generation,
                                RuntimeEvent::RuntimeError {
                                    generation,
                                    code: RuntimeErrorCode::ProcessIo,
                                    message: message.clone(),
                                },
                            );
                        }
                        let _ = reply.send(result);
                    }
                    Some(ProcessCommand::Stop { reply }) => {
                        let was_current = generations.is_current(generation);
                        if was_current {
                            process_state.set(PiProcessState::Stopping);
                            sink.send(RuntimeEvent::ProcessState {
                                generation,
                                state: PiProcessState::Stopping,
                            });
                            generations.deactivate(generation);
                        }

                        let result = stop_child(&mut child).await;
                        await_reader(&mut stdout_task).await;
                        await_reader(&mut stderr_task).await;

                        if was_current {
                            match &result {
                                Ok(()) => {
                                    process_state.set(PiProcessState::Stopped);
                                    sink.send(RuntimeEvent::ProcessState {
                                        generation,
                                        state: PiProcessState::Stopped,
                                    });
                                }
                                Err(message) => {
                                    process_state.set(PiProcessState::Failed);
                                    sink.send(RuntimeEvent::RuntimeError {
                                        generation,
                                        code: RuntimeErrorCode::ProcessIo,
                                        message: message.clone(),
                                    });
                                    sink.send(RuntimeEvent::ProcessState {
                                        generation,
                                        state: PiProcessState::Failed,
                                    });
                                }
                            }
                        }

                        let _ = reply.send(result);
                        break;
                    }
                    None => {
                        let was_current = generations.is_current(generation);
                        if was_current {
                            generations.deactivate(generation);
                        }
                        let result = stop_child(&mut child).await;
                        await_reader(&mut stdout_task).await;
                        await_reader(&mut stderr_task).await;
                        if was_current {
                            process_state.set(if result.is_ok() {
                                PiProcessState::Stopped
                            } else {
                                PiProcessState::Failed
                            });
                        }
                        break;
                    }
                }
            }
        }
    }
}

async fn write_stdin(stdin: &mut ChildStdin, data: &[u8]) -> Result<(), String> {
    stdin
        .write_all(data)
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

async fn stop_child(child: &mut Child) -> Result<(), String> {
    match child.try_wait().map_err(|error| error.to_string())? {
        Some(_) => Ok(()),
        None => child.kill().await.map_err(|error| error.to_string()),
    }
}

async fn await_reader(task: &mut Option<JoinHandle<()>>) {
    if let Some(mut task) = task.take() {
        if tokio::time::timeout(Duration::from_secs(1), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}

const MAX_STDOUT_READY_PREAMBLE_BYTES: usize = 256 * 1024;

#[derive(Debug)]
struct StdoutReadyGate {
    marker: Option<Vec<u8>>,
    buffered: Vec<u8>,
    ready: bool,
}

impl StdoutReadyGate {
    fn new(marker: Option<String>) -> Self {
        let ready = marker.is_none();
        Self {
            marker: marker.map(String::into_bytes),
            buffered: Vec::new(),
            ready,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Option<Vec<u8>>, String> {
        if self.ready {
            return Ok(Some(chunk.to_vec()));
        }

        self.buffered.extend_from_slice(chunk);
        if self.buffered.len() > MAX_STDOUT_READY_PREAMBLE_BYTES {
            return Err(format!(
                "Pi RPC stdout ready marker was not found within {MAX_STDOUT_READY_PREAMBLE_BYTES} bytes"
            ));
        }

        let marker = self
            .marker
            .as_deref()
            .expect("unready gate requires marker");
        let Some(index) = find_subslice(&self.buffered, marker) else {
            return Ok(None);
        };
        let after_marker = index + marker.len();
        let payload_start = if self.buffered.get(after_marker) == Some(&b'\n') {
            after_marker + 1
        } else if self.buffered.get(after_marker..after_marker + 2) == Some(b"\r\n") {
            after_marker + 2
        } else {
            return Ok(None);
        };

        self.ready = true;
        self.marker = None;
        let payload = self.buffered[payload_start..].to_vec();
        self.buffered.clear();
        Ok(Some(payload))
    }

    fn finish(&self) -> Result<(), String> {
        if self.ready {
            Ok(())
        } else {
            Err("Pi RPC stdout ended before the transport ready marker was received".to_owned())
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn read_stdout<S: RuntimeEventSink>(
    mut stdout: ChildStdout,
    generation: u64,
    generations: Arc<GenerationClock>,
    sink: S,
    stdout_ready_marker: Option<String>,
) {
    let mut gate = StdoutReadyGate::new(stdout_ready_marker);
    let mut codec = JsonlCodec::new();
    let mut adapter = PiEventAdapter::default();
    let mut buffer = [0_u8; 8192];

    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) => {
                if let Err(message) = gate.finish() {
                    send_if_current(
                        &generations,
                        &sink,
                        generation,
                        RuntimeEvent::RuntimeError {
                            generation,
                            code: RuntimeErrorCode::RpcFraming,
                            message,
                        },
                    );
                } else if let Err(error) = codec.finish() {
                    send_codec_error(&generations, &sink, generation, error);
                }
                break;
            }
            Ok(read) => {
                let payload = match gate.push(&buffer[..read]) {
                    Ok(Some(payload)) => payload,
                    Ok(None) => continue,
                    Err(message) => {
                        send_if_current(
                            &generations,
                            &sink,
                            generation,
                            RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::RpcFraming,
                                message,
                            },
                        );
                        break;
                    }
                };

                for frame in codec.push(&payload) {
                    match frame {
                        Ok(message) => {
                            send_if_current(
                                &generations,
                                &sink,
                                generation,
                                RuntimeEvent::RpcMessage {
                                    generation,
                                    message: message.clone(),
                                },
                            );
                            for event in adapter.adapt(generation, &message) {
                                send_if_current(&generations, &sink, generation, event);
                            }
                        }
                        Err(error) => send_codec_error(&generations, &sink, generation, error),
                    }
                }
            }
            Err(error) => {
                send_if_current(
                    &generations,
                    &sink,
                    generation,
                    RuntimeEvent::RuntimeError {
                        generation,
                        code: RuntimeErrorCode::ProcessIo,
                        message: error.to_string(),
                    },
                );
                break;
            }
        }
    }
}

async fn read_stderr<S: RuntimeEventSink>(
    mut stderr: ChildStderr,
    generation: u64,
    generations: Arc<GenerationClock>,
    sink: S,
) {
    let mut buffer = [0_u8; 4096];

    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                send_if_current(
                    &generations,
                    &sink,
                    generation,
                    RuntimeEvent::RuntimeLog {
                        generation,
                        stream: RuntimeLogStream::Stderr,
                        message: String::from_utf8_lossy(&buffer[..read]).into_owned(),
                    },
                );
            }
            Err(error) => {
                send_if_current(
                    &generations,
                    &sink,
                    generation,
                    RuntimeEvent::RuntimeError {
                        generation,
                        code: RuntimeErrorCode::ProcessIo,
                        message: error.to_string(),
                    },
                );
                break;
            }
        }
    }
}

fn send_codec_error<S: RuntimeEventSink>(
    generations: &GenerationClock,
    sink: &S,
    generation: u64,
    error: RpcCodecError,
) {
    let code = match error {
        RpcCodecError::InvalidJson(_) => RuntimeErrorCode::RpcDecode,
        RpcCodecError::UnterminatedFrame { .. } => RuntimeErrorCode::RpcFraming,
    };
    send_if_current(
        generations,
        sink,
        generation,
        RuntimeEvent::RuntimeError {
            generation,
            code,
            message: error.to_string(),
        },
    );
}

fn send_if_current<S: RuntimeEventSink>(
    generations: &GenerationClock,
    sink: &S,
    generation: u64,
    event: RuntimeEvent,
) -> bool {
    if generations.is_current(generation) {
        sink.send(event);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    #[cfg(unix)]
    use std::{collections::BTreeMap, time::Duration};
    #[cfg(unix)]
    use tokio::sync::Notify;

    use super::*;

    #[derive(Clone, Default)]
    struct TestSink {
        events: Arc<StdMutex<Vec<RuntimeEvent>>>,
        #[cfg(unix)]
        notify: Arc<Notify>,
    }

    impl RuntimeEventSink for TestSink {
        fn send(&self, event: RuntimeEvent) {
            self.events.lock().unwrap().push(event);
            #[cfg(unix)]
            self.notify.notify_one();
        }
    }

    #[cfg(unix)]
    impl TestSink {
        async fn wait_for(&self, predicate: impl Fn(&RuntimeEvent) -> bool) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if self.events.lock().unwrap().iter().any(&predicate) {
                        return;
                    }
                    self.notify.notified().await;
                }
            })
            .await
            .expect("timed out waiting for runtime event");
        }
    }

    #[test]
    fn generations_are_monotonic_and_stale_events_are_ignored() {
        let generations = GenerationClock::default();
        let sink = TestSink::default();

        let first = generations.activate_next();
        assert!(send_if_current(
            &generations,
            &sink,
            first,
            RuntimeEvent::AssistantTextDelta {
                generation: first,
                delta: "first".to_owned(),
            },
        ));

        let second = generations.activate_next();
        assert_eq!(second, first + 1);
        assert!(!send_if_current(
            &generations,
            &sink,
            first,
            RuntimeEvent::AssistantTextDelta {
                generation: first,
                delta: "stale".to_owned(),
            },
        ));
        assert!(send_if_current(
            &generations,
            &sink,
            second,
            RuntimeEvent::AssistantTextDelta {
                generation: second,
                delta: "second".to_owned(),
            },
        ));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1],
            RuntimeEvent::AssistantTextDelta {
                generation: second,
                delta: "second".to_owned(),
            }
        );
    }

    #[test]
    fn deactivation_only_affects_matching_generation() {
        let generations = GenerationClock::default();
        let first = generations.activate_next();
        let second = generations.activate_next();

        assert!(!generations.deactivate(first));
        assert!(generations.is_current(second));
        assert!(generations.deactivate(second));
        assert!(!generations.is_current(second));
    }

    #[tokio::test]
    async fn stop_accepts_terminal_state_when_actor_closes_reply_channel() {
        let generations = Arc::new(GenerationClock::default());
        let generation = generations.activate_next();
        let process_state = Arc::new(ProcessStateCell::default());
        process_state.set(PiProcessState::Running);
        let (sender, mut receiver) = mpsc::channel(PROCESS_COMMAND_CAPACITY);
        let mut session = PiSession {
            generations,
            process_state: Arc::clone(&process_state),
            control: Some(ProcessControl { generation, sender }),
            launch: None,
        };

        tokio::spawn(async move {
            if let Some(ProcessCommand::Stop { reply }) = receiver.recv().await {
                process_state.set(PiProcessState::Stopped);
                drop(reply);
            }
        });

        let snapshot = session.stop().await.unwrap();
        assert_eq!(snapshot.state, PiProcessState::Stopped);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_process_exit_emits_crash_error_and_failed_state() {
        let mut session = PiSession::default();
        let sink = TestSink::default();
        let connection: Connection = serde_json::from_value(serde_json::json!({
            "id": "local-crash-test",
            "name": "Local Crash Test",
            "kind": { "type": "local" }
        }))
        .unwrap();
        let process = ProcessSpec {
            program: "sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                "printf 'fixture crash\n' >&2; exit 7".to_owned(),
            ],
            cwd: None,
            env: BTreeMap::new(),
            stdout_ready_marker: None,
        };

        let generation = session
            .spawn(sink.clone(), connection, None, process)
            .await
            .unwrap()
            .generation;

        sink.wait_for(|event| {
            matches!(
                event,
                RuntimeEvent::RuntimeError {
                    generation: event_generation,
                    code: RuntimeErrorCode::ProcessExit,
                    message,
                } if *event_generation == generation && message.contains("status")
            )
        })
        .await;
        sink.wait_for(|event| {
            matches!(
                event,
                RuntimeEvent::ProcessState {
                    generation: event_generation,
                    state: PiProcessState::Failed,
                } if *event_generation == generation
            )
        })
        .await;

        assert_eq!(session.snapshot().state, PiProcessState::Failed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_lifecycle_routes_rpc_and_stderr_separately() {
        let mut session = PiSession::default();
        let sink = TestSink::default();
        let connection: Connection = serde_json::from_value(serde_json::json!({
            "id": "local-test",
            "name": "Local Test",
            "kind": { "type": "local" }
        }))
        .unwrap();
        let process = ProcessSpec {
            program: "sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                "while IFS= read -r line; do printf '%s\\n' \"$line\"; printf '%s\\n' '{\"type\":\"agent_end\",\"willRetry\":false,\"messages\":[{\"role\":\"assistant\",\"stopReason\":\"aborted\"}]}'; printf '%s\\n' '{\"type\":\"agent_settled\"}'; printf '%s\\n' 'fixture stderr' >&2; done".to_owned(),
            ],
            cwd: None,
            env: BTreeMap::new(),
            stdout_ready_marker: None,
        };

        let first = session
            .spawn(sink.clone(), connection, None, process)
            .await
            .unwrap();
        assert_eq!(first.state, PiProcessState::Running);
        assert_eq!(first.generation, 1);

        session.abort().await.unwrap();
        sink.wait_for(|event| {
            matches!(
                event,
                RuntimeEvent::RpcMessage { generation, message }
                    if *generation == first.generation
                        && message.get("type").and_then(Value::as_str) == Some("abort")
            )
        })
        .await;
        sink.wait_for(|event| {
            matches!(
                event,
                RuntimeEvent::AssistantMessageEnd {
                    generation,
                    stop_reason: Some(stop_reason),
                    ..
                } if *generation == first.generation && stop_reason == "aborted"
            )
        })
        .await;
        sink.wait_for(|event| {
            matches!(
                event,
                RuntimeEvent::RuntimeLog { generation, stream: RuntimeLogStream::Stderr, message }
                    if *generation == first.generation && message.contains("fixture stderr")
            )
        })
        .await;

        let stopped = session.stop().await.unwrap();
        assert_eq!(stopped.state, PiProcessState::Stopped);

        let restarted = session.restart(sink.clone()).await.unwrap();
        assert_eq!(restarted.state, PiProcessState::Running);
        assert_eq!(restarted.generation, first.generation + 1);

        let stopped_again = session.stop().await.unwrap();
        assert_eq!(stopped_again.state, PiProcessState::Stopped);
    }
}
