use std::{
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use pilo_protocol::MAX_BINARY_PAYLOAD_BYTES;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{
    ServerReply, ServerState,
    environment::{cached_login_path, process_command, resolve_program},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandParams {
    project: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default = "default_command_timeout_ms")]
    timeout_ms: u64,
}

const fn default_command_timeout_ms() -> u64 {
    60_000
}

pub(crate) async fn read_bounded_output<R>(
    mut reader: R,
    used: Arc<AtomicUsize>,
    overflowed: Arc<AtomicBool>,
    limit: usize,
) -> Result<Vec<u8>, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(output);
        }
        let previous = used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                Some(value.saturating_add(read))
            })
            .unwrap_or_else(|value| value);
        if previous < limit {
            let keep = read.min(limit - previous);
            output.extend_from_slice(&buffer[..keep]);
            if keep < read {
                overflowed.store(true, Ordering::Release);
            }
        } else {
            overflowed.store(true, Ordering::Release);
        }
    }
}

pub(crate) async fn command_run(
    state: &ServerState,
    params: CommandParams,
    input: Vec<u8>,
) -> Result<ServerReply, String> {
    if input.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "command input is {} bytes; pilo-server limit is {} bytes",
            input.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    let path = cached_login_path(state).await;
    let program = resolve_program(&path, &params.program);
    let mut command = process_command(&program, &params.args, &path);
    command
        .current_dir(&params.project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run '{program}': {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "command stdin unavailable".to_owned())?;
    let stdin_write = async move {
        if !input.is_empty() {
            stdin
                .write_all(&input)
                .await
                .map_err(|error| error.to_string())?;
        }
        drop(stdin);
        Ok::<(), String>(())
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "command stdout unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "command stderr unavailable".to_owned())?;
    let used = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let stdout_read = read_bounded_output(
        stdout,
        Arc::clone(&used),
        Arc::clone(&overflowed),
        MAX_BINARY_PAYLOAD_BYTES,
    );
    let stderr_read = read_bounded_output(
        stderr,
        Arc::clone(&used),
        Arc::clone(&overflowed),
        MAX_BINARY_PAYLOAD_BYTES,
    );
    let timeout_ms = params.timeout_ms.clamp(1, 10 * 60 * 1000);
    let result = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
        tokio::join!(stdin_write, stdout_read, stderr_read, child.wait())
    })
    .await;
    let (stdout, stderr, status) = match result {
        Ok((stdin, stdout, stderr, status)) => {
            stdin.map_err(|error| format!("failed to write command stdin: {error}"))?;
            (
                stdout.map_err(|error| format!("failed to read command stdout: {error}"))?,
                stderr.map_err(|error| format!("failed to read command stderr: {error}"))?,
                status.map_err(|error| error.to_string())?,
            )
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!(
                "command '{}' timed out after {timeout_ms} ms",
                params.program
            ));
        }
    };
    if overflowed.load(Ordering::Acquire) {
        return Err(format!(
            "command '{}' produced more than {} bytes; output was discarded after the limit",
            params.program, MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    Ok(ServerReply::with_binary(
        json!({ "code": status.code() }),
        vec![stdout, stderr],
    ))
}
