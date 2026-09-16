use std::{process::Stdio, sync::Arc};

#[cfg(debug_assertions)]
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use pilo_protocol::{Envelope, MAX_BINARY_PAYLOAD_BYTES};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::Mutex,
};

use crate::ServerState;
use crate::environment::{cached_toolchain, process_command, resolve_program};

pub(crate) struct PiProcess {
    pub(crate) child: Child,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
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
    disable_resources: bool,
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

#[cfg(debug_assertions)]
fn trace_pi(stage: &str, stream_id: &str, detail: Value) {
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

#[cfg(not(debug_assertions))]
fn trace_pi(_stage: &str, _stream_id: &str, _detail: Value) {}

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
    let toolchain = cached_toolchain(state).await?;
    let path = toolchain.path.clone();
    let pi_executable = params
        .pi_executable
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| resolve_program(&path, value))
        .unwrap_or_else(|| toolchain.pi_executable.clone());
    if pi_executable.is_empty() {
        return Err("Pi executable 'pi' was not found in PATH".to_owned());
    }
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
        args.extend(["--system-prompt".to_owned(), system_prompt.clone()]);
    }
    let mut command = process_command(&pi_executable, &args, &path);
    command
        .current_dir(&params.project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start Pi RPC: {error}"))?;
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
    processes.insert(params.stream_id.clone(), PiProcess { child, stdin });
    drop(processes);

    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let pi = Arc::clone(&state.pi);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let bytes = line.into_bytes();
                    if bytes.len() > MAX_BINARY_PAYLOAD_BYTES {
                        if writer
                            .send(Envelope::event(
                                stream_id.clone(),
                                "pi.error",
                                json!({
                                    "message": format!(
                                        "Pi stdout RPC line is {} bytes; pilo-server limit is {} bytes",
                                        bytes.len(),
                                        MAX_BINARY_PAYLOAD_BYTES
                                    ),
                                }),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
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
        let process = pi.lock().await.remove(&stream_id);
        let exit_status = if let Some(process) = process {
            let PiProcess { mut child, stdin } = process;
            drop(stdin);
            match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) => Some(status),
                Ok(Err(_)) => None,
                Err(_) => {
                    let _ = child.kill().await;
                    child.wait().await.ok()
                }
            }
        } else {
            None
        };
        let code = exit_status.as_ref().and_then(|status| status.code());
        let success = exit_status.as_ref().is_some_and(|status| status.success());
        trace_pi(
            "pi.stdout_closed",
            &stream_id,
            json!({ "code": code, "success": success }),
        );
        let _ = writer
            .send(Envelope::event(
                stream_id,
                "pi.stdout_closed",
                json!({ "code": code, "success": success }),
            ))
            .await;
    });
    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    tokio::spawn(async move {
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
    let mut stdin = stdin.lock().await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| format!("timed out while writing Pi stream '{}'", params.stream_id))?
    .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn pi_stop(state: &ServerState, params: PiStopParams) -> Result<Value, String> {
    let Some(mut process) = state.pi.lock().await.remove(&params.stream_id) else {
        trace_pi("pi.stop", &params.stream_id, json!({ "found": false }));
        return Ok(Value::Null);
    };
    trace_pi(
        "pi.stop",
        &params.stream_id,
        json!({ "found": true, "childPid": process.child.id() }),
    );
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
    Ok(Value::Null)
}
