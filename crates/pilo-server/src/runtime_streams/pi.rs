use std::{
    process::Stdio,
    sync::{Arc, Mutex as StdMutex, Weak},
};

#[cfg(debug_assertions)]
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use pilo_protocol::{BuiltinExtension, Envelope, MAX_BINARY_PAYLOAD_BYTES};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::Mutex,
};

use crate::environment::{process_command, resolve_pi_executable};
use crate::{PiOutputTasks, PiStarts, ServerState};

pub(crate) struct PiProcess {
    pub(crate) child: Child,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
}

impl PiProcess {
    pub(crate) async fn stop(self) -> Result<std::process::ExitStatus, String> {
        let Self { mut child, stdin } = self;
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

async fn stop_registered_pi(
    processes: &Mutex<std::collections::HashMap<String, PiProcess>>,
    starts: &Mutex<PiStarts>,
    stops: &Mutex<tokio::task::JoinSet<()>>,
    outputs: &StdMutex<PiOutputTasks>,
    stream_id: &str,
    expected_stdin: Option<&Weak<Mutex<ChildStdin>>>,
) -> Result<Option<std::process::ExitStatus>, String> {
    let stopped = {
        let mut processes = processes.lock().await;
        let mut stops = stops.lock().await;
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

async fn read_rpc_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let bytes = newline.unwrap_or(buffer.len());
        if line.len().saturating_add(bytes) > MAX_BINARY_PAYLOAD_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Pi stdout RPC line exceeds the byte limit",
            ));
        }
        line.extend_from_slice(&buffer[..bytes]);
        reader.consume(bytes + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiStartParams {
    stream_id: String,
    project: String,
    #[serde(default)]
    control_stream_id: Option<String>,
    #[serde(default)]
    remote_control: Option<pilo_protocol::ControlContext>,
    #[serde(default)]
    session_path: Option<String>,
    #[serde(default)]
    no_session: bool,
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
pub(crate) struct PiStopParams {
    stream_id: String,
}

fn trace_pi(stage: &str, stream_id: &str, detail: Value) {
    if matches!(stage, "pi.start" | "pi.stop" | "pi.stdout_closed") {
        eprintln!(
            "[runtime-diagnostics] {}",
            json!({
                "pid": std::process::id(), "stage": stage, "streamId": stream_id, "detail": detail,
            })
        );
    }
    #[cfg(debug_assertions)]
    {
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let record = json!({
            "tsMs": ts_ms,
            "pid": std::process::id(),
            "source": "pilo-server",
            "stage": stage,
            "sessionKey": Value::Null,
            "streamId": stream_id,
            "detail": detail,
        });
        let path =
            std::env::temp_dir().join(format!("pilo-runtime-trace-{}.jsonl", std::process::id()));
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        let mut line = record.to_string();
        line.push('\n');
        let _ = file.write_all(line.as_bytes());
    }
}

/// Write an inline extension source to a content-addressed temp file so it can
/// be loaded with an explicit `--extension` flag. Pi runs in this environment,
/// so the file must live on the local (possibly remote-managed) filesystem.
fn materialize_extension(source: &str) -> Result<std::path::PathBuf, String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(source, &mut hasher);
    let dir = std::env::temp_dir().join("pilo-extensions");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create extension dir: {error}"))?;
    prune_stale_extensions(&dir);
    let path = dir.join(format!("{:016x}.js", std::hash::Hasher::finish(&hasher)));
    if !path.exists() {
        std::fs::write(&path, source)
            .map_err(|error| format!("failed to write extension file: {error}"))?;
    }
    Ok(path)
}

/// Extensions are content-addressed, so distinct SSH configurations accumulate
/// distinct files. Drop entries far older than any realistic Pi session.
fn prune_stale_extensions(dir: &std::path::Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if now.duration_since(modified).is_ok_and(|age| age > MAX_AGE) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn extension_path_argument(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) {
        normalize_windows_extension_path(&value)
    } else {
        value.into_owned()
    }
}

fn normalize_windows_extension_path(value: &str) -> String {
    // Bun's module loader cannot resolve the verbatim paths returned by canonicalize.
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{value}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
}

/// Windows batch launchers (`pi.cmd`, `pi.bat`) reach the CLI through
/// `cmd.exe`, whose argument parsing rejects a newline outright. Native
/// launchers such as `pi` or `pi.exe` pass the value straight through, so a
/// multi-line system prompt keeps its paragraphs and lists there.
fn is_batch_launcher(executable: &str) -> bool {
    std::path::Path::new(executable)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

fn system_prompt_argument(executable: &str, prompt: &str) -> String {
    if cfg!(windows) && is_batch_launcher(executable) {
        prompt.replace(['\r', '\n'], " ")
    } else {
        prompt.to_owned()
    }
}

fn trace_pi_rpc_line(stream_id: &str, bytes: &[u8]) {
    #[cfg(debug_assertions)]
    {
        let Ok(message) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        let Some(event_type) = message.get("type").and_then(Value::as_str) else {
            return;
        };
        let traceable = matches!(
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
        );
        if !traceable {
            return;
        }
        let role = message.pointer("/message/role").and_then(Value::as_str);
        let stop_reason = message
            .pointer("/message/stopReason")
            .and_then(Value::as_str);
        trace_pi(
            "pi.stdout",
            stream_id,
            json!({
                "event": event_type,
                "id": message.get("id"),
                "command": message.get("command"),
                "success": message.get("success"),
                "role": role,
                "stopReason": stop_reason,
                "willRetry": message.get("willRetry"),
                "toolCallId": message.get("toolCallId"),
                "toolName": message.get("toolName"),
            }),
        );
    }

    #[cfg(not(debug_assertions))]
    let _ = (stream_id, bytes);
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
    let mut args = vec!["--mode".to_owned(), "rpc".to_owned()];
    if params.no_session {
        args.push("--no-session".to_owned());
    } else if let Some(path) = params.session_path.as_ref() {
        args.extend(["--session".to_owned(), path.clone()]);
    }
    if params.disable_resources {
        args.extend([
            "--no-tools".to_owned(),
            "--no-extensions".to_owned(),
            "--no-skills".to_owned(),
            "--no-prompt-templates".to_owned(),
            "--no-themes".to_owned(),
            "--no-context-files".to_owned(),
            "--no-approve".to_owned(),
        ]);
    }
    if params.disable_builtin_tools {
        args.push("--no-builtin-tools".to_owned());
    }
    if params.disable_extension_discovery {
        args.push("--no-extensions".to_owned());
    }
    if params.disable_context_files {
        args.push("--no-context-files".to_owned());
    }
    for source in &params.extensions {
        if source.trim().is_empty() {
            continue;
        }
        let path = materialize_extension(source)?;
        // Explicit --extension paths still load when discovery is disabled.
        args.extend(["--extension".to_owned(), extension_path_argument(&path)]);
    }
    let mut ssh_workspace_config = None;
    let mut builtin_names = std::collections::HashSet::new();
    for extension in &params.builtin_extensions {
        let filename = crate::extensions::filename(extension);
        if !builtin_names.insert(filename) {
            return Err("duplicate Pi builtin extension".to_owned());
        }
        if let BuiltinExtension::SshWorkspace { config } = extension {
            if !config.remote_cwd.starts_with('/')
                || config.remote_cwd.contains('\0')
                || config.ssh_args.is_empty()
                || config.ssh_args.iter().any(|arg| arg.contains('\0'))
                || config.ssh_environment.iter().any(|(key, value)| {
                    key.is_empty() || key.contains(['=', '\0']) || value.contains('\0')
                })
            {
                return Err("invalid SSH workspace configuration".to_owned());
            }
            ssh_workspace_config =
                Some(serde_json::to_string(config).map_err(|error| error.to_string())?);
        }
        args.extend([
            "--extension".to_owned(),
            extension_path_argument(&state.extensions_dir.join(filename)),
        ]);
    }
    if let Some(provider) = params.provider.as_ref() {
        args.extend(["--provider".to_owned(), provider.clone()]);
    }
    if let Some(model) = params.model.as_ref() {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(thinking) = params.thinking.as_ref() {
        args.extend(["--thinking".to_owned(), thinking.clone()]);
    }
    if let Some(system_prompt) = params.system_prompt.as_ref() {
        args.extend([
            "--system-prompt".to_owned(),
            system_prompt_argument(&pi_executable, system_prompt),
        ]);
    }
    let control = params
        .control_stream_id
        .as_deref()
        .map(|stream| {
            state
                .agent_control
                .context(stream)
                .ok_or_else(|| "unregistered Pilo control context".to_owned())
        })
        .transpose()?;
    if control.is_some() {
        args.extend(["--append-system-prompt".to_owned(), "Pilo application control is available through bash: invoke the executable in PILO_CTL with the ctl subcommand (POSIX: \"$PILO_CTL\" ctl; PowerShell: & $env:PILO_CTL ctl). Start with ctl --help and ctl settings list. This controls the running Pilo Host; use explicit --connection/--project for scoped writes. Never print PILO_CONTROL_TOKEN or put credentials in command arguments; use --stdin JSON. Failed writes must not be automatically retried.".to_owned()]);
    }
    let mut command = process_command(&pi_executable, &args, &path);
    for key in [
        "PILO_CTL",
        "PILO_CONTROL_ENDPOINT",
        "PILO_CONTROL_TOKEN",
        "PILO_REMOTE_CONTROL",
    ] {
        command.env_remove(key);
    }
    if let Some(control) = control {
        command
            .env("PILO_CTL", control.executable)
            .env("PILO_CONTROL_ENDPOINT", control.endpoint)
            .env("PILO_CONTROL_TOKEN", control.token);
    }
    if let Some(control) = &params.remote_control {
        command.env(
            "PILO_REMOTE_CONTROL",
            serde_json::to_string(control)
                .map_err(|_| "invalid remote control context".to_owned())?,
        );
    }
    command
        .current_dir(&params.project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Never inherit another launcher/session's workspace configuration.
    command.env_remove("PILO_SSH_WORKSPACE_CONFIG");
    if let Some(config) = ssh_workspace_config {
        command.env("PILO_SSH_WORKSPACE_CONFIG", config);
    }
    #[cfg(unix)]
    command.process_group(0);
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
    processes.insert(params.stream_id.clone(), PiProcess { child, stdin });

    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let pi = Arc::clone(&state.pi);
    let starts = Arc::clone(&state.pi_starts);
    let stops = Arc::clone(&state.pi_stops);
    let outputs = Arc::clone(&state.pi_output_tasks);
    let stdout_identity = stdin_identity.clone();
    let agent_control = state.agent_control.clone();
    let control_stream = params.control_stream_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_rpc_line(&mut reader).await {
                Ok(Some(bytes)) => {
                    trace_pi_rpc_line(&stream_id, &bytes);
                    if writer
                        .send(Envelope::event_with_binary(
                            stream_id.clone(),
                            "pi.rpc_json",
                            Value::Null,
                            vec![bytes],
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = writer
                        .send(Envelope::event(
                            stream_id.clone(),
                            "pi.error",
                            json!({ "message": error.to_string() }),
                        ))
                        .await;
                    break;
                }
            }
        }
        let exit_status = match stop_registered_pi(
            &pi,
            &starts,
            &stops,
            &outputs,
            &stream_id,
            Some(&stdout_identity),
        )
        .await
        {
            Ok(Some(status)) => Some(status),
            Ok(None) => return,
            Err(error) => {
                eprintln!(
                    "[runtime-diagnostics] Pi stdout cleanup failed streamId={stream_id} error={error}"
                );
                None
            }
        };
        if let Some(stream) = control_stream {
            agent_control.revoke(&stream);
        }
        let code = exit_status.as_ref().and_then(|status| status.code());
        let success = exit_status.as_ref().is_some_and(|status| status.success());
        trace_pi(
            "pi.stdout_closed",
            &stream_id,
            json!({ "code": code, "success": success }),
        );
        let _ = writer
            .send(Envelope::event(
                stream_id.clone(),
                "pi.stdout_closed",
                json!({ "code": code, "success": success }),
            ))
            .await;
        let _processes = pi.lock().await;
        let output = {
            let mut outputs = outputs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if outputs
                .get(&stream_id)
                .is_some_and(|(identity, _)| identity.ptr_eq(&stdout_identity))
            {
                outputs.remove(&stream_id)
            } else {
                None
            }
        };
        if let Some((_, [_, stderr_task])) = output {
            stderr_task.abort();
            let _ = stderr_task.await;
        }
    });
    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = vec![0_u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    if writer
                        .send(Envelope::event_with_binary(
                            stream_id.clone(),
                            "pi.stderr",
                            Value::Null,
                            vec![buffer[..read].to_vec()],
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    state
        .pi_output_tasks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            params.stream_id,
            (stdin_identity, [stdout_task, stderr_task]),
        );
    drop(processes);
    Ok(json!({ "started": true }))
}

pub(crate) async fn pi_send(state: &ServerState, params: PiSendParams) -> Result<Value, String> {
    if !params.command.is_object() {
        return Err("Pi RPC command must be a JSON object".to_owned());
    }
    trace_pi(
        "pi.send",
        &params.stream_id,
        json!({
            "command": params.command.get("type"),
            "id": params.command.get("id"),
        }),
    );
    let stdin = {
        let processes = state.pi.lock().await;
        Arc::clone(
            &processes
                .get(&params.stream_id)
                .ok_or_else(|| format!("Pi stream '{}' is not running", params.stream_id))?
                .stdin,
        )
    };
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
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| {
        eprintln!("[runtime-diagnostics] pi.send timeout pid={} streamId={} command={} rpcId={} payloadBytes={} elapsedMs={} lockWaitMs={lock_wait_ms}", std::process::id(), params.stream_id, params.command.get("type").and_then(Value::as_str).unwrap_or("unknown"), params.command.get("id").and_then(Value::as_str).unwrap_or("none"), bytes.len(), started.elapsed().as_millis());
        format!("timed out while writing Pi stream '{}'", params.stream_id)
    })?
    .map_err(|error| {
        eprintln!("[runtime-diagnostics] pi.send failed pid={} streamId={} kind={:?} elapsedMs={}", std::process::id(), params.stream_id, error.kind(), started.elapsed().as_millis());
        error.to_string()
    })?;
    Ok(Value::Null)
}

pub(crate) async fn pi_stop(state: &ServerState, params: PiStopParams) -> Result<Value, String> {
    state
        .agent_control
        .revoke(&format!("control:{}", params.stream_id));
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
    )
    .await?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::{extension_path_argument, normalize_windows_extension_path};
    use std::path::Path;

    #[test]
    fn windows_extension_paths_use_loader_compatible_syntax() {
        for (input, expected) in [
            (
                r"\\?\C:\Users\Lenovo\AppData\Local\Pilo\server\extensions\model-catalog.js",
                r"C:\Users\Lenovo\AppData\Local\Pilo\server\extensions\model-catalog.js",
            ),
            (
                r"\\?\C:\Users\测试 用户\Pilo\extensions\next-prompt.js",
                r"C:\Users\测试 用户\Pilo\extensions\next-prompt.js",
            ),
            (
                r"\\?\UNC\server\shared folder\extensions\model-catalog.js",
                r"\\server\shared folder\extensions\model-catalog.js",
            ),
            (
                r"C:\Temp\pilo-extensions\inline.js",
                r"C:\Temp\pilo-extensions\inline.js",
            ),
            (
                r"\\server\share\extension.js",
                r"\\server\share\extension.js",
            ),
        ] {
            assert_eq!(normalize_windows_extension_path(input), expected);
        }
    }

    #[test]
    fn only_batch_launchers_are_treated_as_cmd_wrapped() {
        use super::is_batch_launcher;

        for launcher in [r"C:\tools\pi.cmd", "pi.cmd", "pi.CMD", r"C:\Pilo\pi.bat"] {
            assert!(
                is_batch_launcher(launcher),
                "{launcher} should be a batch launcher"
            );
        }
        for launcher in [
            "pi",
            "pi.exe",
            r"C:\tools\pi.exe",
            r"C:\dir.cmd\pi",
            "/usr/bin/pi",
        ] {
            assert!(
                !is_batch_launcher(launcher),
                "{launcher} should not be a batch launcher"
            );
        }
    }

    #[test]
    fn multiline_system_prompts_only_collapse_for_batch_launchers() {
        use super::system_prompt_argument;

        let prompt = "Line one\r\nLine two\nLine three";
        let batch = system_prompt_argument("pi.cmd", prompt);
        let native = system_prompt_argument("pi.exe", prompt);
        if cfg!(windows) {
            assert_eq!(batch, "Line one  Line two Line three");
        } else {
            assert_eq!(batch, prompt);
        }
        assert_eq!(native, prompt);
    }

    #[test]
    fn extension_path_arguments_only_normalize_on_windows() {
        let verbatim = r"\\?\C:\Pilo\extensions\model-catalog.js";
        assert_eq!(
            extension_path_argument(Path::new(verbatim)),
            if cfg!(windows) {
                r"C:\Pilo\extensions\model-catalog.js"
            } else {
                verbatim
            }
        );
        let ordinary = if cfg!(windows) {
            r"C:\Users\测试 用户\extensions\inline.js"
        } else {
            "/home/测试 用户/.cache/pilo/server/extensions/model-catalog.js"
        };
        assert_eq!(extension_path_argument(Path::new(ordinary)), ordinary);
    }
}
