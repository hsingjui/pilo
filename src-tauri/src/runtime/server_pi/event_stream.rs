use std::sync::Arc;

use serde_json::{Value, json};
use tokio::{
    task::JoinHandle,
    time::{Duration, MissedTickBehavior},
};

use super::StateCell;
use crate::runtime::{
    events::{PiProcessState, RuntimeErrorCode, RuntimeEvent, RuntimeEventSink, RuntimeLogStream},
    pi_events::PiEventAdapter,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient},
    server_pi_events::{
        adapt_pi_rpc, dispatch_runtime_event, dispatch_runtime_events, flush_runtime_events,
        trace_pi_transport_event,
    },
};

const RUNTIME_EVENT_BATCH_MS: u64 = 16;

pub(super) fn spawn_event_task<S: RuntimeEventSink>(
    client: Arc<ServerClient>,
    sink: S,
    state: Arc<StateCell>,
    stream_id: String,
    generation: u64,
) -> JoinHandle<()> {
    let mut events = client.subscribe(&stream_id);
    tokio::spawn(async move {
        let mut adapter = PiEventAdapter::default();
        let mut buffered_runtime_events = Vec::new();
        let mut flush_tick = tokio::time::interval(Duration::from_millis(RUNTIME_EVENT_BATCH_MS));
        flush_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        // interval fires immediately on its first tick. Consume that tick so the
        // first streamed delta gets a real coalescing window.
        flush_tick.tick().await;
        loop {
            let received = tokio::select! {
                _ = flush_tick.tick() => {
                    flush_runtime_events(&sink, &mut buffered_runtime_events);
                    continue;
                }
                event = events.recv() => event,
            };
            let Some(event) = received else {
                flush_runtime_events(&sink, &mut buffered_runtime_events);
                if matches!(
                    state.get(),
                    PiProcessState::Running | PiProcessState::Starting
                ) {
                    state.set(PiProcessState::Failed);
                    sink.send(RuntimeEvent::RuntimeError {
                        generation,
                        code: RuntimeErrorCode::ProcessIo,
                        message: "pilo-server disconnected while Pi was running".to_owned(),
                    });
                    sink.send(RuntimeEvent::ProcessState {
                        generation,
                        state: PiProcessState::Failed,
                    });
                }
                break;
            };
            if event.event == SERVER_DISCONNECTED_EVENT {
                flush_runtime_events(&sink, &mut buffered_runtime_events);
                if matches!(
                    state.get(),
                    PiProcessState::Running | PiProcessState::Starting
                ) {
                    state.set(PiProcessState::Failed);
                    sink.send(RuntimeEvent::RuntimeError {
                        generation,
                        code: RuntimeErrorCode::ProcessIo,
                        message: event
                            .data
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("pilo-server disconnected while Pi was running")
                            .to_owned(),
                    });
                    sink.send(RuntimeEvent::ProcessState {
                        generation,
                        state: PiProcessState::Failed,
                    });
                }
                if event.data.get("overflow").and_then(Value::as_bool) == Some(true) {
                    let _ = client
                        .request("pi.stop", json!({ "streamId": &stream_id }))
                        .await;
                }
                break;
            }
            if event.stream_id != stream_id {
                continue;
            }
            match event.event.as_str() {
                "pi.rpc" => {
                    let data = event.data.clone();
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
        }
        flush_runtime_events(&sink, &mut buffered_runtime_events);
    })
}
