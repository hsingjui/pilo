mod launch;
mod output;
mod trace;

use std::{
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

use pilo_protocol::{BuiltinExtension, MAX_BINARY_PAYLOAD_BYTES};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin},
    sync::Mutex,
};

use launch::{PiLaunch, build_launch_command};
use output::spawn_output_tasks;
use trace::trace_pi;

use crate::environment::resolve_pi_executable;
use crate::{PiOutputTasks, PiStarts, ServerState};

pub(crate) struct PiProcess {
    pub(crate) child: Child,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    work: Arc<StdMutex<PiWork>>,
    track_work: bool,
}

#[derive(Default)]
struct PiWork {
    active: bool,
    compacting: bool,
    tools: std::collections::HashSet<String>,
    queued: usize,
    // Mixed or untracked input stays unowned until the queue drains.
    queue_owner: Option<String>,
    clearing_stalled_queue: bool,
    // Clients restore unsent queued input after a stall; late queue input would duplicate it.
    stalled_input_closed: bool,
    warming_until: u64,
    pending: std::collections::HashMap<String, PendingCommand>,
    dialogs: std::collections::HashMap<String, (Value, Option<std::time::Instant>)>,
}

struct PendingCommand {
    kind: String,
    queue_owner: Option<String>,
}

impl PiWork {
    fn is_busy(&self) -> bool {
        self.active
            || self.compacting
            || self.has_queued_input()
            || self.clearing_stalled_queue
            || !self.pending.is_empty()
            || !self.tools.is_empty()
            || self
                .dialogs
                .values()
                .any(|(_, until)| until.is_none_or(|until| until > std::time::Instant::now()))
    }

    fn has_queued_input(&self) -> bool {
        self.queued != 0
    }

    fn pending_chat_input(&self) -> impl Iterator<Item = &PendingCommand> {
        self.pending
            .values()
            .filter(|command| queues_chat_input(&command.kind))
    }

    fn has_pending_chat_input(&self) -> bool {
        self.pending_chat_input().next().is_some()
    }

    // Pi emits queue_update before the corresponding input reply. When
    // several inputs are in flight it doesn't identify which one queued.
    fn pending_queue_owner(&self) -> Option<&str> {
        let mut pending = self.pending_chat_input();
        let owner = pending.next()?.queue_owner.as_deref()?;
        pending
            .all(|command| command.queue_owner.as_deref() == Some(owner))
            .then_some(owner)
    }

    fn observe(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str) {
            Some("agent_start" | "auto_retry_start") => {
                self.active = true;
                self.stalled_input_closed = false;
            }
            Some("agent_settled") => {
                self.active = false;
                self.tools.clear();
            }
            Some("tool_execution_start" | "tool_execution_end") => {
                if let Some(id) = event.get("toolCallId").and_then(Value::as_str) {
                    if event["type"] == "tool_execution_start" {
                        self.tools.insert(id.to_owned());
                    } else {
                        self.tools.remove(id);
                    }
                }
            }
            Some("compaction_start" | "summarization_retry_scheduled") => self.compacting = true,
            Some("compaction_end") => {
                self.compacting = event
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            }
            Some("summarization_retry_finished") => self.compacting = false,
            Some("queue_update") => {
                let queued = ["steering", "followUp"]
                    .iter()
                    .filter_map(|key| event.get(*key).and_then(Value::as_array))
                    .map(Vec::len)
                    .sum();
                if queued == 0 {
                    self.queue_owner = None;
                } else if queued > self.queued {
                    let owner = self.pending_queue_owner();
                    self.queue_owner = if self.queued == 0 || self.queue_owner.as_deref() == owner {
                        owner.map(str::to_owned)
                    } else {
                        None
                    };
                }
                self.queued = queued;
            }
            Some("response") => {
                let command = event.get("command").and_then(Value::as_str);
                let id = event.get("id").and_then(Value::as_str).unwrap_or_default();
                if command.is_some()
                    && self.pending.get(id).map(|pending| pending.kind.as_str()) == command
                {
                    self.pending.remove(id);
                }
                if command == Some("compact")
                    && event.get("success").and_then(Value::as_bool) == Some(false)
                {
                    self.compacting = false;
                }
            }
            Some("extension_ui_request")
                if matches!(
                    event.get("method").and_then(Value::as_str),
                    Some("select" | "confirm" | "input" | "editor")
                ) =>
            {
                if let Some(id) = event.get("id").and_then(Value::as_str) {
                    let deadline = event.get("timeout").and_then(Value::as_u64).and_then(|ms| {
                        std::time::Instant::now().checked_add(std::time::Duration::from_millis(ms))
                    });
                    self.dialogs.retain(|_, (_, until)| {
                        until.is_none_or(|until| until > std::time::Instant::now())
                    });
                    self.dialogs
                        .insert(id.to_owned(), (event.clone(), deadline));
                }
            }
            Some("extension_ui_request")
                if event.get("widgetKey").and_then(Value::as_str)
                    == Some("pilo.cache-keep-alive.v1") =>
            {
                let now = unix_time_ms();
                self.warming_until = event
                    .pointer("/widgetLines/0")
                    .and_then(Value::as_str)
                    .and_then(|line| serde_json::from_str::<Value>(line).ok())
                    .filter(|status| {
                        matches!(
                            status.get("status").and_then(Value::as_str),
                            Some("scheduled" | "warming")
                        )
                    })
                    .and_then(|status| status.get("expiresAtMs").and_then(Value::as_u64))
                    .filter(|expires| *expires <= now.saturating_add(86_400_000))
                    .unwrap_or_default();
            }
            _ => {}
        }
    }
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

impl PiProcess {
    #[cfg(unix)]
    pub(crate) fn has_work(&self) -> bool {
        let work = self
            .work
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        work.is_busy() || work.warming_until > unix_time_ms()
    }

    pub(crate) fn attach_state(&self) -> Value {
        let work = self
            .work
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dialogs = work
            .dialogs
            .values()
            .filter_map(|(dialog, until)| {
                if let Some(until) = until {
                    let remaining = until.checked_duration_since(std::time::Instant::now())?;
                    let mut dialog = dialog.clone();
                    dialog["timeout"] = json!(remaining.as_millis() as u64);
                    Some(dialog)
                } else {
                    Some(dialog.clone())
                }
            })
            .collect::<Vec<_>>();
        json!({ "active": work.active || work.has_queued_input() || work.clearing_stalled_queue || !work.pending.is_empty(), "compacting": work.compacting, "dialogs": dialogs })
    }

    pub(crate) async fn stop(self) -> Result<std::process::ExitStatus, String> {
        let Self {
            mut child, stdin, ..
        } = self;
        // EOF lets Pi run session_shutdown hooks before any force-kill fallback.
        drop(stdin);
        if let Ok(Ok(status)) =
            tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await
        {
            return Ok(status);
        }
        if let Some(pid) = child.id() {
            #[cfg(unix)]
            let mut killer = {
                let mut command = tokio::process::Command::new("/bin/kill");
                command.args(["-KILL", "--", &format!("-{pid}")]);
                command
            };
            #[cfg(windows)]
            let mut killer = {
                let mut command = tokio::process::Command::new("taskkill.exe");
                command.args(["/PID", &pid.to_string(), "/T", "/F"]);
                command.creation_flags(0x0800_0000);
                command
            };
            #[cfg(any(unix, windows))]
            {
                killer
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                if !matches!(tokio::time::timeout(std::time::Duration::from_secs(1), killer.status()).await, Ok(Ok(status)) if status.success())
                {
                    eprintln!(
                        "[runtime-diagnostics] Pi process tree cleanup failed childPid={pid}; killing direct child"
                    );
                }
            }
        }
        let _ = child.start_kill();
        tokio::time::timeout(std::time::Duration::from_secs(1), child.wait())
            .await
            .map_err(|_| "timed out while stopping Pi process".to_owned())?
            .map_err(|error| format!("failed to stop Pi process: {error}"))
    }
}

async fn abort_output_tasks(tasks: [tokio::task::JoinHandle<()>; 2]) {
    for task in &tasks {
        task.abort();
    }
    for task in tasks {
        let _ = task.await;
    }
}

fn ensure_pi_idle(process: Option<&PiProcess>) -> Result<(), String> {
    if process.is_some_and(|process| {
        process
            .work
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_busy()
    }) {
        return Err("SSH_LOCAL_PI_RESOURCES_BUSY".to_owned());
    }
    Ok(())
}

async fn stop_registered_pi(
    processes: &Mutex<std::collections::HashMap<String, PiProcess>>,
    starts: &Mutex<PiStarts>,
    stops: &Mutex<tokio::task::JoinSet<()>>,
    outputs: &StdMutex<PiOutputTasks>,
    stream_id: &str,
    expected_stdin: Option<&Weak<Mutex<ChildStdin>>>,
    only_if_idle: bool,
) -> Result<Option<std::process::ExitStatus>, String> {
    let stopped = {
        let mut processes = processes.lock().await;
        let mut stops = stops.lock().await;
        if only_if_idle {
            ensure_pi_idle(processes.get(stream_id))?;
        }
        let output = if let Some(expected_stdin) = expected_stdin {
            // EOF belongs to this process instance, not to a replacement or pending start.
            if !processes
                .get(stream_id)
                .is_some_and(|process| expected_stdin.ptr_eq(&Arc::downgrade(&process.stdin)))
            {
                return Ok(None);
            }
            None
        } else {
            // Only explicit stop cancels pending starts for this stream.
            starts.lock().await.retain(|_, (key, _)| key != stream_id);
            outputs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(stream_id)
        };
        let process = processes.remove(stream_id);
        if process.is_none() && output.is_none() {
            return Ok(None);
        }
        while stops.try_join_next().is_some() {}
        let (reply, stopped) = tokio::sync::oneshot::channel();
        // Removal and registration have no await between them: cancellation
        // cannot strand a child outside both the live and stopping registries.
        stops.spawn(async move {
            let result = match process {
                Some(process) => process.stop().await.map(Some),
                None => Ok(None),
            };
            if let Some((_, tasks)) = output {
                // Join output tasks before ACK, even if EOF cleanup already removed the child.
                abort_output_tasks(tasks).await;
            }
            if let Err(error) = &result {
                eprintln!("[runtime-diagnostics] Pi stop failed: {error}");
            }
            let _ = reply.send(result);
        });
        stopped
    };
    stopped
        .await
        .map_err(|_| "Pi stop task ended unexpectedly".to_owned())?
}

const STALLED_INPUT_CLOSED: &str = "PILO_STALLED_TURN_INPUT_CLOSED";
static PI_INPUT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn queues_chat_input(command: &str) -> bool {
    matches!(command, "prompt" | "steer" | "follow_up")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiStartParams {
    stream_id: String,
    project: String,
    #[serde(default)]
    session_path: Option<String>,
    #[serde(default)]
    no_session: bool,
    #[serde(default)]
    user_scope: bool,
    #[serde(default)]
    disable_resources: bool,
    /// Inline extension sources materialized to temp files and loaded with
    /// explicit `--extension` flags for this process only.
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    builtin_extensions: Vec<BuiltinExtension>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    pi_executable: Option<String>,
    #[serde(default)]
    disable_builtin_tools: bool,
    #[serde(default)]
    disable_extension_discovery: bool,
    #[serde(default)]
    disable_context_files: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiSendParams {
    stream_id: String,
    command: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiCheckIdleParams {
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiStopParams {
    stream_id: String,
    #[serde(default)]
    only_if_idle: bool,
}

pub(crate) async fn pi_start(state: &ServerState, params: PiStartParams) -> Result<Value, String> {
    let (pi_executable, path) =
        resolve_pi_executable(state, params.pi_executable.as_deref()).await?;
    let mut processes = state.pi.lock().await;
    if processes.contains_key(&params.stream_id) {
        trace_pi(
            "pi.start",
            &params.stream_id,
            json!({ "alreadyRunning": true }),
        );
        return Ok(json!({ "alreadyRunning": true }));
    }
    let PiLaunch {
        mut command,
        uses_ssh_workspace,
    } = build_launch_command(state, &params, &pi_executable, &path)?;
    // Wait for old output tasks before allowing a replacement to publish any events.
    let old_output = state
        .pi_output_tasks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&params.stream_id);
    if let Some((_, tasks)) = old_output {
        abort_output_tasks(tasks).await;
    }
    let mut child = command.spawn().map_err(|error| {
        eprintln!(
            "[runtime-diagnostics] pi.start failed pid={} streamId={} error={error}",
            std::process::id(),
            params.stream_id
        );
        format!("failed to start Pi RPC: {error}")
    })?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "Pi stdin unavailable".to_owned())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Pi stdout unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Pi stderr unavailable".to_owned())?;
    let child_pid = child.id();
    trace_pi(
        "pi.start",
        &params.stream_id,
        json!({
            "alreadyRunning": false,
            "childPid": child_pid,
            "hasSessionPath": params.session_path.is_some(),
            "noSession": params.no_session,
        }),
    );
    let stdin_identity = Arc::downgrade(&stdin);
    let work = Arc::new(StdMutex::new(PiWork::default()));
    let watch_stalls = params
        .builtin_extensions
        .contains(&BuiltinExtension::StreamGuard);
    let track_work = state.retain_pi || uses_ssh_workspace || watch_stalls;
    processes.insert(
        params.stream_id.clone(),
        PiProcess {
            child,
            stdin,
            work: Arc::clone(&work),
            track_work,
        },
    );

    let output_tasks = spawn_output_tasks(
        state,
        &params,
        (stdout, stderr),
        &stdin_identity,
        work,
        track_work,
        watch_stalls,
    );
    state
        .pi_output_tasks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(params.stream_id, (stdin_identity, output_tasks));
    drop(processes);
    Ok(json!({ "started": true }))
}

pub(crate) async fn pi_send(
    state: &ServerState,
    mut params: PiSendParams,
) -> Result<Value, String> {
    let command_fields = params
        .command
        .as_object_mut()
        .ok_or_else(|| "Pi RPC command must be a JSON object".to_owned())?;
    let queue_owner = command_fields.remove("piloQueueOwner");
    let queue_owner = queue_owner
        .as_ref()
        .and_then(Value::as_str)
        .filter(|owner| !owner.is_empty() && owner.len() <= 64);
    trace_pi(
        "pi.send",
        &params.stream_id,
        json!({
            "command": params.command.get("type"),
            "id": params.command.get("id"),
        }),
    );
    let (stdin, work, track_work) = {
        let processes = state.pi.lock().await;
        let process = processes
            .get(&params.stream_id)
            .ok_or_else(|| format!("Pi stream '{}' is not running", params.stream_id))?;
        (
            Arc::clone(&process.stdin),
            Arc::clone(&process.work),
            process.track_work,
        )
    };
    let guarded_clear = params.command["type"] == "pilo_clear_owned_queue";
    let queued_follow_up = params.command["type"] == "pilo_follow_up_prompt";
    if guarded_clear {
        params.command["type"] = json!("clear_queue");
    } else if queued_follow_up {
        params.command["type"] = json!("prompt");
    }
    let command = params.command["type"].as_str().unwrap_or_default();
    let queues_input = queues_chat_input(command);
    let starts_after_stall = command == "prompt" && !queued_follow_up;
    let tracked = track_work && (queues_input || matches!(command, "compact" | "bash"));
    if track_work && queues_input && params.command["id"].as_str().is_none_or(str::is_empty) {
        params.command["id"] = json!(format!(
            "pilo-server-input-{}",
            PI_INPUT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
    }
    let mut bytes = serde_json::to_vec(&params.command).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "Pi RPC command is {} bytes; pilo-server limit is {} bytes",
            bytes.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    bytes.push(b'\n');
    let started = std::time::Instant::now();
    let mut stdin = stdin.lock().await;
    let lock_wait_ms = started.elapsed().as_millis();
    let command = params.command["type"].as_str().unwrap_or_default();
    let id = params
        .command
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tracked || guarded_clear {
        let mut work = work
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The stdin lock orders this check with every Pilo client write. An
        // earlier input handler may still be awaiting before it queues its message.
        if guarded_clear
            && (!track_work
                || queue_owner.is_none()
                || work.clearing_stalled_queue
                || work.has_pending_chat_input()
                || (work.has_queued_input() && work.queue_owner.as_deref() != queue_owner))
        {
            return Err("Pi queue ownership changed; the queue was not cleared".to_owned());
        }
        // Only a new prompt may follow a stalled turn; queue input sent before the
        // client saw the stall is already back in its draft.
        if queues_input
            && (work.clearing_stalled_queue || (work.stalled_input_closed && !starts_after_stall))
        {
            return Err(STALLED_INPUT_CLOSED.to_owned());
        }
        if tracked {
            if work
                .pending
                .get(id)
                .is_some_and(|pending| queues_input || queues_chat_input(&pending.kind))
            {
                return Err("Pi RPC id is already in use".to_owned());
            }
            work.pending.insert(
                id.to_owned(),
                PendingCommand {
                    kind: command.to_owned(),
                    queue_owner: queue_owner.map(str::to_owned),
                },
            );
        }
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| {
        eprintln!("[runtime-diagnostics] pi.send timeout pid={} streamId={} command={} rpcId={} payloadBytes={} elapsedMs={} lockWaitMs={lock_wait_ms}", std::process::id(), params.stream_id, params.command.get("type").and_then(Value::as_str).unwrap_or("unknown"), params.command.get("id").and_then(Value::as_str).unwrap_or("none"), bytes.len(), started.elapsed().as_millis());
        format!("timed out while writing Pi stream '{}'", params.stream_id)
    })
    .and_then(|result| result.map_err(|error| {
        eprintln!("[runtime-diagnostics] pi.send failed pid={} streamId={} kind={:?} elapsedMs={}", std::process::id(), params.stream_id, error.kind(), started.elapsed().as_millis());
        error.to_string()
    }));
    if track_work {
        let mut work = work
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if tracked && result.is_err() {
            work.pending.remove(id);
        }
        if result.is_ok() && starts_after_stall {
            work.stalled_input_closed = false;
        }
        if result.is_ok() && command == "extension_ui_response" {
            work.dialogs.remove(id);
        }
    }
    result.map(|()| Value::Null)
}

pub(crate) async fn pi_check_idle(
    state: &ServerState,
    params: PiCheckIdleParams,
) -> Result<Value, String> {
    let processes = state.pi.lock().await;
    ensure_pi_idle(processes.get(&params.stream_id))?;
    Ok(Value::Null)
}

pub(crate) async fn pi_stop(state: &ServerState, params: PiStopParams) -> Result<Value, String> {
    let pid = state
        .pi
        .lock()
        .await
        .get(&params.stream_id)
        .and_then(|process| process.child.id());
    trace_pi(
        "pi.stop",
        &params.stream_id,
        json!({ "found": pid.is_some(), "childPid": pid }),
    );
    stop_registered_pi(
        &state.pi,
        &state.pi_starts,
        &state.pi_stops,
        &state.pi_output_tasks,
        &params.stream_id,
        None,
        params.only_if_idle,
    )
    .await?;
    Ok(Value::Null)
}
