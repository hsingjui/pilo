use std::{
    io::{Read, Write},
    sync::Arc,
};

use pilo_protocol::Envelope;
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::environment::{cached_login_path, default_shell};
use crate::{ServerState, blocking};

pub(crate) struct TerminalSession {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) child: Box<dyn PtyChild + Send + Sync>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOpenParams {
    stream_id: String,
    project: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalWriteParams {
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalResizeParams {
    stream_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCloseParams {
    stream_id: String,
}

pub(crate) async fn terminal_open(
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

pub(crate) async fn terminal_write(
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

pub(crate) async fn terminal_resize(
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

pub(crate) async fn terminal_close(
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
