use std::{process::Stdio, sync::Arc};

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
        let _ = writer
            .send(Envelope::event(
                stream_id,
                "pi.stdout_closed",
                json!({
                    "code": exit_status.as_ref().and_then(|status| status.code()),
                    "success": exit_status.as_ref().is_some_and(|status| status.success()),
                }),
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
        return Ok(Value::Null);
    };
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
    Ok(Value::Null)
}
