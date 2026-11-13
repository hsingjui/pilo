use std::sync::{Arc, Weak, atomic::Ordering};

use serde_json::{Value, json};
use tokio::{
    task::JoinHandle,
    time::{Duration, MissedTickBehavior},
};

use super::StateCell;
use crate::runtime::{
    events::{PiProcessState, RuntimeErrorCode, RuntimeEvent, RuntimeEventSink, RuntimeLogStream},
    pi_events::PiEventAdapter,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager},
    server_pi_events::{
        adapt_pi_rpc, dispatch_runtime_event, dispatch_runtime_events, flush_runtime_events,
        trace_pi_transport_event,
    },
};

const RUNTIME_EVENT_BATCH_MS: u64 = 16;

fn observe_input_assistance(state: &StateCell, data: &Value) {
    if data.get("type").and_then(Value::as_str) == Some("extension_ui_request")
        && data.get("method").and_then(Value::as_str) == Some("setWidget")
        && data.get("widgetKey").and_then(Value::as_str) == Some("pilo.cache-keep-alive.v1")
        && let Some(lines) = data.get("widgetLines").and_then(Value::as_array)
        && lines.len() == 1
        && let Some(line) = lines[0].as_str().filter(|line| line.len() <= 4096)
        && let Ok(status) = serde_json::from_str::<crate::domain::CacheKeepAliveStatus>(line)
        && status.expires_at_ms <= crate::runtime::storage::now_ms().saturating_add(86_400_000)
    {
        *state
            .cache_keep_alive
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(status);
    }
    if data.get("type").and_then(Value::as_str) == Some("extension_ui_request")
        && data.get("method").and_then(Value::as_str) == Some("setWidget")
        && data.get("widgetKey").and_then(Value::as_str) == Some("pilo.next-prompt.ready.v1")
    {
        state.next_prompt_ready.store(
            data.get("widgetLines") == Some(&json!(["ready"])),
            Ordering::Release,
        );
    }
}

pub(super) fn spawn_event_task<S: RuntimeEventSink>(
    client: Arc<ServerClient>,
    sink: S,
    state: Arc<StateCell>,
    stream_id: String,
    generation: u64,
    recovery: Option<(Weak<ServerManager>, crate::domain::Connection)>,
) -> JoinHandle<()> {
    let mut events = client.subscribe(&stream_id);
    tokio::spawn(async move {
        let mut client = client;
        let mut adapter = PiEventAdapter::default();
        let mut buffered_runtime_events = Vec::new();
        let mut flush_tick = tokio::time::interval(Duration::from_millis(RUNTIME_EVENT_BATCH_MS));
        flush_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        // interval fires immediately on its first tick. Consume that tick so the
        // first streamed delta gets a real coalescing window.
        flush_tick.tick().await;
        'events: loop {
            let received = tokio::select! {
                _ = flush_tick.tick(), if !buffered_runtime_events.is_empty() => {
                    flush_runtime_events(&sink, &mut buffered_runtime_events);
                    continue;
                }
                event = events.recv() => event,
            };
            let event = match received {
                Some(event) if event.event != SERVER_DISCONNECTED_EVENT => event,
                disconnected => {
                    flush_runtime_events(&sink, &mut buffered_runtime_events);
                    let overflow = disconnected.as_ref().is_some_and(|event| {
                        event.data.get("overflow").and_then(Value::as_bool) == Some(true)
                    });
                    if state.get() == PiProcessState::Running
                        && !overflow
                        && let Some((servers, connection)) = &recovery
                    {
                        let mut delay = Duration::from_millis(250);
                        loop {
                            let Some(servers) = servers.upgrade() else {
                                return;
                            };
                            if state.get() != PiProcessState::Running || servers.is_shutting_down()
                            {
                                return;
                            }
                            let next = match servers.recover_ssh_client(connection).await {
                                Ok(Some(next)) => Some(next),
                                Ok(None) => break,
                                Err(_) => None,
                            };
                            if let Some(next) = next {
                                let next_events = next.subscribe(&stream_id);
                                match next
                                    .request("pi.attach", json!({ "streamId": stream_id }))
                                    .await
                                {
                                    Ok(snapshot) if snapshot.is_null() => break,
                                    Ok(snapshot) => {
                                        if state.get() != PiProcessState::Running {
                                            return;
                                        }
                                        state.resume_control(&client, &next);
                                        *state
                                            .client
                                            .lock()
                                            .unwrap_or_else(std::sync::PoisonError::into_inner) =
                                            Some(next.clone());
                                        client = next;
                                        events = next_events;
                                        adapter = PiEventAdapter::default();
                                        sink.send(RuntimeEvent::PiReattached {
                                            generation,
                                            active: snapshot["active"].as_bool().unwrap_or(false),
                                            compacting: snapshot["compacting"]
                                                .as_bool()
                                                .unwrap_or(false),
                                        });
                                        if let Some(dialogs) = snapshot["dialogs"].as_array() {
                                            for dialog in dialogs {
                                                for event in adapt_pi_rpc(
                                                    &mut adapter,
                                                    generation,
                                                    dialog.clone(),
                                                ) {
                                                    sink.send(event);
                                                }
                                            }
                                        }
                                        continue 'events;
                                    }
                                    // Attach only reads remote state, so a transient error is safe to retry.
                                    Err(_) => {}
                                }
                            }
                            drop(servers);
                            tokio::time::sleep(delay).await;
                            delay = (delay * 2).min(Duration::from_secs(10));
                        }
                    }
                    if matches!(
                        state.get(),
                        PiProcessState::Running | PiProcessState::Starting
                    ) {
                        state.set(PiProcessState::Failed);
                        sink.send(RuntimeEvent::RuntimeError {
                            generation,
                            code: RuntimeErrorCode::ProcessIo,
                            message: disconnected
                                .as_ref()
                                .and_then(|event| event.data.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("pilo-server disconnected while Pi was running")
                                .to_owned(),
                        });
                        sink.send(RuntimeEvent::ProcessState {
                            generation,
                            state: PiProcessState::Failed,
                        });
                    }
                    if overflow {
                        let _ = client
                            .request("pi.stop", json!({ "streamId": &stream_id }))
                            .await;
                    }
                    break;
                }
            };
            if event.stream_id != stream_id {
                continue;
            }
            let was_empty = buffered_runtime_events.is_empty();
            match event.event.as_str() {
                "pi.rpc" => {
                    let data = event.data.clone();
                    observe_input_assistance(&state, &data);
                    trace_pi_transport_event(&stream_id, &data);
                    dispatch_runtime_events(
                        &sink,
                        &mut buffered_runtime_events,
                        adapt_pi_rpc(&mut adapter, generation, data),
                    );
                }
                "pi.rpc_json" => {
                    let Some(bytes) = event.binary.first() else {
                        flush_runtime_events(&sink, &mut buffered_runtime_events);
                        sink.send(RuntimeEvent::RuntimeError {
                            generation,
                            code: RuntimeErrorCode::RpcFraming,
                            message: "pilo-server Pi RPC event had no JSON payload".to_owned(),
                        });
                        continue;
                    };
                    match serde_json::from_slice::<Value>(bytes) {
                        Ok(data) => {
                            observe_input_assistance(&state, &data);
                            trace_pi_transport_event(&stream_id, &data);
                            dispatch_runtime_events(
                                &sink,
                                &mut buffered_runtime_events,
                                adapt_pi_rpc(&mut adapter, generation, data),
                            );
                        }
                        Err(error) => {
                            flush_runtime_events(&sink, &mut buffered_runtime_events);
                            sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::RpcDecode,
                                message: format!("Pi stdout emitted invalid RPC JSON: {error}"),
                            });
                        }
                    }
                }
                "pi.stderr" => {
                    if let Some(bytes) = event.binary.first() {
                        dispatch_runtime_event(
                            &sink,
                            &mut buffered_runtime_events,
                            RuntimeEvent::RuntimeLog {
                                generation,
                                stream: RuntimeLogStream::Stderr,
                                message: String::from_utf8_lossy(bytes).into_owned(),
                            },
                        );
                    }
                }
                "pi.error" => {
                    dispatch_runtime_event(
                        &sink,
                        &mut buffered_runtime_events,
                        RuntimeEvent::RuntimeError {
                            generation,
                            code: RuntimeErrorCode::ProcessIo,
                            message: event
                                .data
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Pi RPC stream failed")
                                .to_owned(),
                        },
                    );
                }
                "pi.stdout_closed" => {
                    flush_runtime_events(&sink, &mut buffered_runtime_events);
                    if state.get() != PiProcessState::Stopping {
                        let success = event
                            .data
                            .get("success")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let next_state = if success {
                            PiProcessState::Stopped
                        } else {
                            let code = event.data.get("code").and_then(Value::as_i64);
                            sink.send(RuntimeEvent::RuntimeError {
                                generation,
                                code: RuntimeErrorCode::ProcessIo,
                                message: code.map_or_else(
                                    || "Pi RPC exited unexpectedly".to_owned(),
                                    |code| format!("Pi RPC exited with code {code}"),
                                ),
                            });
                            PiProcessState::Failed
                        };
                        state.set(next_state);
                        sink.send(RuntimeEvent::ProcessState {
                            generation,
                            state: next_state,
                        });
                    }
                    break;
                }
                _ => {}
            }
            if was_empty && !buffered_runtime_events.is_empty() {
                flush_tick.reset();
            }
        }
        flush_runtime_events(&sink, &mut buffered_runtime_events);
    })
}
