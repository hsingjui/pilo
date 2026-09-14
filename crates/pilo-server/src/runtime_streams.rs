use std::{
    io::{Read, Write},
    process::Stdio,
    sync::Arc,
};

use pilo_protocol::{Envelope, MAX_BINARY_PAYLOAD_BYTES};
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

use super::{ServerState, blocking, to_value};
use crate::environment::{
    cached_login_path, cached_toolchain, default_shell, process_command, resolve_program,
};

pub(super) struct PiProcess {
    pub(super) child: Child,
    pub(super) stdin: Arc<Mutex<ChildStdin>>,
}

pub(super) struct TerminalSession {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) child: Box<dyn PtyChild + Send + Sync>,
}

pub(super) async fn preview_ports() -> Result<Value, String> {
    if cfg!(windows) {
        let script = "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique";
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
            .await
            .map_err(|_| "timed out while listing preview ports".to_owned())?
            .map_err(|error| error.to_string())?;
        let ports = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u16>().ok())
            .collect::<Vec<_>>();
        return to_value(ports);
    }
    let script = "if command -v ss >/dev/null 2>&1; then ss -ltnH | awk '{a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null | awk 'NR>2 {a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; fi";
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
        .await
        .map_err(|_| "timed out while listing preview ports".to_owned())?
        .map_err(|error| error.to_string())?;
    let ports = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u16>().ok())
        .collect::<Vec<_>>();
    to_value(ports)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalOpenParams {
    stream_id: String,
    project: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalWriteParams {
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalResizeParams {
    stream_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalCloseParams {
    stream_id: String,
}

pub(super) async fn terminal_open(
    state: &ServerState,
    params: TerminalOpenParams,
) -> Result<Value, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: params.rows.max(1),
            cols: params.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open terminal PTY: {error}"))?;

    let shell = default_shell();
    let mut command = CommandBuilder::new(shell);
    command.cwd(&params.project);
    command.env("PATH", cached_login_path(state).await);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start terminal: {error}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to open terminal reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open terminal writer: {error}"))?;

    let stream_id = params.stream_id;
    {
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        if let Some(mut previous) = terminals.remove(&stream_id) {
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
        terminals.insert(
            stream_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let event_stream_id = stream_id.clone();
    let event_writer = state.writer.clone();
    let terminals = Arc::clone(&state.terminals);
    if let Err(error) = std::thread::Builder::new()
        .name(format!("pilo-{stream_id}-reader"))
        .spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = event_writer.blocking_send(Envelope::event(
                            event_stream_id.clone(),
                            "terminal.exit",
                            Value::Null,
                        ));
                        break;
                    }
                    Ok(read) => {
                        if event_writer
                            .blocking_send(Envelope::event_with_binary(
                                event_stream_id.clone(),
                                "terminal.output",
                                Value::Null,
                                vec![buffer[..read].to_vec()],
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = event_writer.blocking_send(Envelope::event(
                            event_stream_id.clone(),
                            "terminal.error",
                            json!({ "message": error.to_string() }),
                        ));
                        break;
                    }
                }
            }
            if let Ok(mut terminals) = terminals.lock()
                && let Some(mut terminal) = terminals.remove(&event_stream_id)
            {
                let _ = terminal.child.kill();
                let _ = terminal.child.wait();
            }
        })
    {
        if let Ok(mut terminals) = state.terminals.lock()
            && let Some(mut terminal) = terminals.remove(&stream_id)
        {
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
        }
        return Err(format!("failed to start terminal reader: {error}"));
    }
    Ok(Value::Null)
}

pub(super) async fn terminal_write(
    state: &ServerState,
    params: TerminalWriteParams,
    data: Vec<u8>,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let mut terminals = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        let terminal = terminals
            .get_mut(&params.stream_id)
            .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
        terminal
            .writer
            .write_all(&data)
            .and_then(|_| terminal.writer.flush())
            .map_err(|error| format!("failed to write terminal '{}': {error}", params.stream_id))?;
        Ok(Value::Null)
    })
    .await
}

pub(super) async fn terminal_resize(
    state: &ServerState,
    params: TerminalResizeParams,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let terminals = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        let terminal = terminals
            .get(&params.stream_id)
            .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
        terminal
            .master
            .resize(PtySize {
                rows: params.rows.max(1),
                cols: params.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                format!("failed to resize terminal '{}': {error}", params.stream_id)
            })?;
        Ok(Value::Null)
    })
    .await
}

pub(super) async fn terminal_close(
    state: &ServerState,
    params: TerminalCloseParams,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let Some(mut terminal) = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?
            .remove(&params.stream_id)
        else {
            return Ok(Value::Null);
        };
        terminal
            .child
            .kill()
            .map_err(|error| format!("failed to stop terminal '{}': {error}", params.stream_id))?;
        let _ = terminal.child.wait();
        Ok(Value::Null)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiStartParams {
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
pub(super) struct PiSendParams {
    stream_id: String,
    command: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiStopParams {
    stream_id: String,
}

pub(super) async fn pi_start(state: &ServerState, params: PiStartParams) -> Result<Value, String> {
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

pub(super) async fn pi_send(state: &ServerState, params: PiSendParams) -> Result<Value, String> {
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

pub(super) async fn pi_stop(state: &ServerState, params: PiStopParams) -> Result<Value, String> {
    let Some(mut process) = state.pi.lock().await.remove(&params.stream_id) else {
        return Ok(Value::Null);
    };
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
    Ok(Value::Null)
}
