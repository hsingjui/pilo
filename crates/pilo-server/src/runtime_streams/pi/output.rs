use std::sync::{Arc, Mutex as StdMutex, Weak};

use pilo_protocol::{Envelope, MAX_BINARY_PAYLOAD_BYTES};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdin, ChildStdout},
    sync::Mutex,
    task::JoinHandle,
};

use super::trace::{fast_rpc_event_type, trace_pi, trace_pi_rpc_line};
use super::{PiStartParams, PiWork, stop_registered_pi};
use crate::ServerState;
use crate::output::ServerWriter;

const STALL_CLEAR_QUEUE_ID: &str = "pilo-stall-clear-queue";
const STALL_QUEUE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn should_observe_rpc_event(bytes: &[u8], watch_stalls: bool) -> bool {
    let Some(event_type) = fast_rpc_event_type(bytes) else {
        return true;
    };
    matches!(
        event_type,
        "agent_start"
            | "auto_retry_start"
            | "agent_settled"
            | "tool_execution_start"
            | "tool_execution_end"
            | "compaction_start"
            | "summarization_retry_scheduled"
            | "compaction_end"
            | "summarization_retry_finished"
            | "queue_update"
            | "response"
            | "extension_ui_request"
    ) || (watch_stalls && event_type == "agent_end")
}

pub(super) fn spawn_output_tasks(
    state: &ServerState,
    params: &PiStartParams,
    (stdout, stderr): (ChildStdout, ChildStderr),
    stdin_identity: &Weak<Mutex<ChildStdin>>,
    work: Arc<StdMutex<PiWork>>,
    track_work: bool,
    watch_stalls: bool,
) -> [JoinHandle<()>; 2] {
    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let pi = Arc::clone(&state.pi);
    let starts = Arc::clone(&state.pi_starts);
    let stops = Arc::clone(&state.pi_stops);
    let outputs = Arc::clone(&state.pi_output_tasks);
    let stdout_identity = Weak::clone(stdin_identity);
    let agent_control = state.agent_control.clone();
    let control_stream = params.control_stream_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut settle_after_stop = None;
        loop {
            match read_rpc_line(&mut reader).await {
                Ok(Some(bytes)) => {
                    trace_pi_rpc_line(&stream_id, &bytes);
                    let mut clear_queue = false;
                    if track_work
                        && should_observe_rpc_event(&bytes, watch_stalls)
                        && let Ok(event) = serde_json::from_slice::<Value>(&bytes)
                    {
                        let mut work = work
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        work.observe(&event);
                        if watch_stalls {
                            match event["type"].as_str() {
                                Some("agent_end") => {
                                    let stalled = ended_with_stream_stall(&event);
                                    work.clearing_stalled_queue = stalled;
                                    work.stalled_input_closed = stalled;
                                }
                                Some("agent_settled") if work.clearing_stalled_queue => {
                                    clear_queue =
                                        work.has_queued_input() || work.has_pending_chat_input();
                                    work.clearing_stalled_queue = clear_queue;
                                }
                                _ => {}
                            }
                        }
                    }
                    if clear_queue {
                        // Abort leaves Pi's queue intact. Do not let clients restore
                        // their drafts until Pi acknowledges clearing it.
                        let result = tokio::time::timeout(
                            STALL_QUEUE_CLEANUP_TIMEOUT,
                            clear_stalled_pi_queue(
                                &mut reader,
                                &stdout_identity,
                                &work,
                                &writer,
                                &stream_id,
                            ),
                        )
                        .await;
                        match result {
                            Ok(Ok(())) => {
                                work.lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .clearing_stalled_queue = false
                            }
                            failure => {
                                eprintln!(
                                    "[runtime-diagnostics] stalled queue cleanup failed streamId={stream_id}: {failure:?}"
                                );
                                settle_after_stop = Some(bytes);
                                break;
                            }
                        }
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
        let exit_status = match stop_registered_pi(
            &pi,
            &starts,
            &stops,
            &outputs,
            &stream_id,
            Some(&stdout_identity),
            false,
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
        if let Some(bytes) = settle_after_stop {
            // A failed clear must never leave a process that can replay the old queue.
            let _ = writer
                .send(Envelope::event_with_binary(
                    stream_id.clone(),
                    "pi.rpc_json",
                    Value::Null,
                    vec![bytes],
                ))
                .await;
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
    [stdout_task, stderr_task]
}

fn ended_with_stream_stall(event: &Value) -> bool {
    event["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| message["role"] == "assistant")
        })
        .and_then(|message| message["errorMessage"].as_str())
        .is_some_and(|error| error.starts_with("PILO_STREAM_STALLED:"))
}

async fn clear_stalled_pi_queue<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    stdin: &Weak<Mutex<ChildStdin>>,
    work: &StdMutex<PiWork>,
    writer: &ServerWriter,
    stream_id: &str,
) -> Result<(), String> {
    let mut sent = false;
    loop {
        // An earlier steer may still be awaiting an async Pi input handler.
        let input_pending = work
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .has_pending_chat_input();
        if !sent && !input_pending {
            let mut command =
                serde_json::to_vec(&json!({ "id": STALL_CLEAR_QUEUE_ID, "type": "clear_queue" }))
                    .map_err(|error| error.to_string())?;
            command.push(b'\n');
            let pipe = stdin.upgrade().ok_or("Pi stdin closed")?;
            let mut pipe = pipe.lock().await;
            pipe.write_all(&command)
                .await
                .map_err(|error| error.to_string())?;
            pipe.flush().await.map_err(|error| error.to_string())?;
            sent = true;
        }
        let bytes = read_rpc_line(reader)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Pi exited before clearing its stalled queue")?;
        trace_pi_rpc_line(stream_id, &bytes);
        if let Ok(event) = serde_json::from_slice::<Value>(&bytes) {
            if sent
                && event["type"] == "response"
                && event["id"] == STALL_CLEAR_QUEUE_ID
                && event["command"] == "clear_queue"
            {
                return if event["success"].as_bool() == Some(true) {
                    Ok(())
                } else {
                    Err("Pi rejected clear_queue".to_owned())
                };
            }
            work.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .observe(&event);
        }
        writer
            .send(Envelope::event_with_binary(
                stream_id.to_owned(),
                "pi.rpc_json",
                Value::Null,
                vec![bytes],
            ))
            .await?;
    }
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
        let newline = memchr::memchr(b'\n', buffer);
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
