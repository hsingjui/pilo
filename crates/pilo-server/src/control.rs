use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use pilo_protocol::{
    CONTROL_MAX_BYTES, CONTROL_TIMEOUT_SECONDS, ControlCall, ControlContext, ControlReply,
    ControlRequest, Envelope,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, oneshot},
    task::JoinSet,
};

use crate::ServerState;

#[derive(Default)]
pub(crate) struct ControlState {
    endpoint: Mutex<String>,
    contexts: Mutex<HashMap<String, ControlContext>>,
    pending: Mutex<HashMap<u64, (String, oneshot::Sender<ControlReply>)>>,
    sequence: std::sync::atomic::AtomicU64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterParams {
    stream_id: String,
    token: String,
    executable: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RespondParams {
    id: u64,
    reply: ControlReply,
}

impl ControlState {
    pub(crate) fn revoke(&self, stream_id: &str) {
        self.contexts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(stream_id);
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, (stream, _)| stream != stream_id);
    }

    pub(crate) fn context(&self, stream_id: &str) -> Option<ControlContext> {
        self.contexts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(stream_id)
            .cloned()
    }

    pub(crate) fn register(&self, params: RegisterParams) -> Result<Value, String> {
        if params.stream_id.is_empty()
            || params.stream_id.len() > 256
            || params.token.len() < 32
            || params.token.len() > 256
        {
            return Err("invalid control context".to_owned());
        }
        let executable = params.executable.map(Ok).unwrap_or_else(|| {
            std::env::current_exe()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })?;
        if !std::path::Path::new(&executable).is_absolute()
            || !std::path::Path::new(&executable).is_file()
        {
            return Err("control executable is unavailable".to_owned());
        }
        let mut contexts = self
            .contexts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if contexts.len() >= 512 || contexts.contains_key(&params.stream_id) {
            return Err("control context capacity exhausted or duplicate context".to_owned());
        }
        let context = ControlContext {
            endpoint: self
                .endpoint
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
            token: params.token,
            executable,
        };
        let result = serde_json::to_value(&context).map_err(|error| error.to_string())?;
        contexts.insert(params.stream_id, context);
        Ok(result)
    }

    pub(crate) fn respond(&self, params: RespondParams) -> Value {
        if let Some((_, sender)) = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&params.id)
        {
            let _ = sender.send(params.reply);
        }
        json!({ "ok": true })
    }
}

struct PendingGuard {
    control: Arc<ControlState>,
    id: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.control
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
    }
}

pub(crate) async fn listen(state: ServerState) -> std::io::Result<tokio::task::JoinHandle<()>> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    *state
        .agent_control
        .endpoint
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = listener.local_addr()?.to_string();
    Ok(tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(32));
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                result = listener.accept() => {
                    let Ok((socket, _)) = result else { break };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                    let state = state.clone();
                    tasks.spawn(async move {
                        let _permit = permit;
                        let _ = tokio::time::timeout(Duration::from_secs(CONTROL_TIMEOUT_SECONDS), handle(socket, state)).await;
                    });
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
            }
        }
    }))
}

async fn read_json<R: tokio::io::AsyncRead + Unpin, T: serde::de::DeserializeOwned>(
    reader: R,
) -> Result<T, String> {
    let mut bytes = Vec::new();
    BufReader::new(reader)
        .take((CONTROL_MAX_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| "control read failed".to_owned())?;
    if bytes.len() > CONTROL_MAX_BYTES || bytes.last() != Some(&b'\n') {
        return Err("invalid control frame size or terminator".to_owned());
    }
    // Parser errors may contain a secret value. Do not echo them.
    serde_json::from_slice(&bytes).map_err(|_| "invalid control JSON".to_owned())
}

async fn write_json<W: tokio::io::AsyncWrite + Unpin, T: serde::Serialize>(
    mut writer: W,
    value: &T,
) -> Result<(), String> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|_| "control serialization failed".to_owned())?;
    if bytes.len() >= CONTROL_MAX_BYTES {
        return Err("control result exceeds byte limit".to_owned());
    }
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| "control write failed".to_owned())
}

async fn handle(mut socket: TcpStream, state: ServerState) -> Result<(), String> {
    let call: ControlCall = tokio::time::timeout(Duration::from_secs(5), read_json(&mut socket))
        .await
        .map_err(|_| "Pilo control authentication timed out".to_owned())??;
    let stream = state
        .agent_control
        .contexts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find(|(_, context)| context.token == call.token)
        .map(|(stream, _)| stream.clone());
    let Some(stream) = stream else {
        return write_json(
            socket,
            &ControlReply {
                result: None,
                error: Some("invalid or expired Pilo control context".to_owned()),
            },
        )
        .await;
    };
    let id = state
        .agent_control
        .sequence
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    state
        .agent_control
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(id, (stream.clone(), sender));
    let _guard = PendingGuard {
        control: state.agent_control.clone(),
        id,
    };
    state
        .writer
        .send(Envelope::event(
            stream,
            "control.request",
            serde_json::to_value(ControlRequest {
                id,
                command: call.command,
            })
            .map_err(|_| "control serialization failed".to_owned())?,
        ))
        .await?;
    let reply = receiver.await.unwrap_or(ControlReply {
        result: None,
        error: Some(
            "Pilo control context ended; write outcome may be unknown; do not automatically retry"
                .to_owned(),
        ),
    });
    write_json(socket, &reply).await
}

const HELP: &str = "Pilo built-in Agent control (JSON results)\nUsage: pilo-server ctl <command> [key] [JSON] [--connection ID] [--project ID] [--stdin] [--json]\nCommands: status; settings list|get|set|reset; connections list|save; projects list|add\nUse --stdin for complex values and credentials. Secrets must never be placed in arguments.\nExample: pilo-server ctl settings set preferences.uiFontSize 16\nExample: pilo-server ctl projects add /work/repo --connection local\nHost must be running. Never automatically retry a failed write.";

pub async fn run_cli(args: Vec<String>) -> Result<(), String> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let mut command = pilo_protocol::ControlCommand {
        method: String::new(),
        key: None,
        connection_id: None,
        project_id: None,
        value: Value::Null,
    };
    let mut positional = Vec::new();
    let mut stdin = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--connection" | "--project" => {
                let id = args
                    .next()
                    .filter(|id| !id.trim().is_empty() && !id.starts_with('-'))
                    .ok_or_else(|| format!("{arg} requires an ID"))?;
                if arg == "--connection" {
                    command.connection_id = Some(id);
                } else {
                    command.project_id = Some(id);
                }
            }
            "--stdin" => stdin = true,
            "--json" => {}
            flag if flag.starts_with("--") => return Err("unknown ctl option".to_owned()),
            _ => positional.push(arg),
        }
    }
    if positional.first().is_some_and(|arg| arg == "status") && positional.len() == 1 {
        command.method = "status".to_owned();
    } else if positional.len() >= 2 {
        command.method = format!("{}.{}", positional[0], positional[1]);
        command.key = positional.get(2).cloned();
        if positional.len() > 4 {
            return Err("too many ctl arguments".to_owned());
        }
        if let Some(value) = positional.get(3) {
            command.value = serde_json::from_str(value)
                .map_err(|_| "value must be JSON; quote strings with JSON quotes".to_owned())?;
        }
    } else {
        return Err(HELP.to_owned());
    }
    if !matches!(
        command.method.as_str(),
        "status"
            | "settings.list"
            | "settings.get"
            | "settings.set"
            | "settings.reset"
            | "connections.list"
            | "connections.save"
            | "projects.list"
            | "projects.add"
    ) {
        return Err("unknown ctl command; use ctl --help".to_owned());
    }
    let value_command = command.method == "settings.set"
        || (command.method == "settings.reset"
            && command.key.as_deref() == Some("connection.cacheKeepAlive"));
    let expected = match command.method.as_str() {
        "status" => 1,
        "settings.get" | "settings.set" | "settings.reset" | "projects.add" => 3,
        _ => 2,
    };
    if positional.len() != expected && !(value_command && !stdin && positional.len() == 4) {
        return Err("invalid ctl arguments; use ctl --help".to_owned());
    }
    if stdin && !value_command && command.method != "connections.save" {
        return Err("this command does not accept stdin JSON".to_owned());
    }
    if command.method == "settings.set" && !stdin && positional.len() != 4 {
        return Err("settings set requires a JSON argument or --stdin".to_owned());
    }
    if command.method == "connections.save" && !stdin {
        return Err(
            "connections save requires --stdin (credentials must not appear in arguments)"
                .to_owned(),
        );
    }
    if stdin {
        if positional.len() > 3 {
            return Err("--stdin cannot be combined with a JSON argument".to_owned());
        }
        let mut bytes = Vec::new();
        tokio::io::stdin()
            .take((CONTROL_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "stdin read failed".to_owned())?;
        if bytes.len() > CONTROL_MAX_BYTES {
            return Err("stdin exceeds byte limit".to_owned());
        }
        command.value =
            serde_json::from_slice(&bytes).map_err(|_| "stdin must contain JSON".to_owned())?;
    }
    let endpoint: std::net::SocketAddr = std::env::var("PILO_CONTROL_ENDPOINT")
        .map_err(|_| "not running in a Pilo-managed interactive session".to_owned())?
        .parse()
        .map_err(|_| "invalid control endpoint".to_owned())?;
    if !endpoint.ip().is_loopback() {
        return Err("control endpoint must be loopback".to_owned());
    }
    let token = std::env::var("PILO_CONTROL_TOKEN")
        .map_err(|_| "missing Pilo control context".to_owned())?;
    let reply = tokio::time::timeout(Duration::from_secs(CONTROL_TIMEOUT_SECONDS + 5), async {
        let mut socket = TcpStream::connect(endpoint)
            .await
            .map_err(|_| "Pilo Host is offline or control context expired".to_owned())?;
        write_json(&mut socket, &ControlCall { token, command }).await?;
        read_json::<_, ControlReply>(&mut socket)
            .await
            .map_err(|error| {
                format!("{error}; write outcome may be unknown; do not automatically retry")
            })
    })
    .await
    .map_err(|_| {
        "Pilo control timed out; write outcome is unknown; do not automatically retry".to_owned()
    })??;
    if let Some(error) = reply.error {
        return Err(error);
    }
    println!(
        "{}",
        serde_json::to_string(&reply.result.unwrap_or(Value::Null))
            .map_err(|error| error.to_string())?
    );
    Ok(())
}
