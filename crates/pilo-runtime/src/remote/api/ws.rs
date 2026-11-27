use std::{sync::Arc, time::Duration};

use axum::{
    extract::{
        Extension, Query, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::{events::SequencedRuntimeEvent, host_paths::HostPaths, remote::auth};

use super::{AuthSession, RemoteHttpState};

const WS_BATCH_WINDOW: Duration = Duration::from_millis(16);
const WS_BATCH_MAX_EVENTS: usize = 64;

#[derive(Deserialize)]
pub(super) struct EventQuery {
    after: Option<u64>,
}

pub(super) async fn events(
    state: RemoteHttpState,
    Extension(auth_session): Extension<AuthSession>,
    Query(query): Query<EventQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.protocols(["pilo"])
        .on_upgrade(move |socket| event_socket(socket, state, auth_session, query.after))
}

async fn refresh_auth_session(
    paths: &HostPaths,
    session: &mut AuthSession,
    auth_generation: u64,
) -> bool {
    let paths = paths.clone();
    let token = session.token.clone();
    let device = tokio::task::spawn_blocking(move || {
        auth::authenticate_cached(&paths, &token, auth_generation)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .flatten();
    let Some(device) = device else {
        return false;
    };
    session.device = device;
    true
}

async fn event_socket(
    mut socket: WebSocket,
    state: RemoteHttpState,
    mut auth_session: AuthSession,
    after: Option<u64>,
) {
    let events = state.runtime.events.clone();
    let paths = state.runtime.paths.clone();
    let mut lifetime = state.runtime.downgrade();
    let mut shutdown = state.shutdown.clone();
    let mut auth_generation = state.auth_generation.clone();
    drop(state);
    let mut receiver = events.subscribe_web();
    let snapshot_sequence = events.latest_sequence();
    log::info!(target: "remote-webui", "event socket opened deviceId={} after={after:?} latestSequence={snapshot_sequence}", auth_session.device.id);

    if send_ws_json(
        &mut socket,
        &json!({
            "type": "hello",
            "deviceId": auth_session.device.id,
            "latestSequence": snapshot_sequence,
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    if let Some(after) = after {
        match events.replay_after(after) {
            Some(replay) => {
                let replay = replay
                    .into_iter()
                    .filter(|event| event.sequence <= snapshot_sequence)
                    .collect::<Vec<_>>();
                for chunk in replay.chunks(WS_BATCH_MAX_EVENTS) {
                    if send_event_batch(&mut socket, chunk).await.is_err() {
                        return;
                    }
                }
            }
            None => {
                log::warn!(target: "remote-webui", "event replay gap deviceId={} after={after} latestSequence={snapshot_sequence}", auth_session.device.id);
                if send_ws_json(
                    &mut socket,
                    &json!({ "type": "resyncRequired", "latestSequence": snapshot_sequence }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
        }
    }

    let mut auth_tick = tokio::time::interval(Duration::from_secs(15));
    auth_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    auth_tick.tick().await;

    let close_reason = loop {
        tokio::select! {
            _ = lifetime.closed() => {
                let _ = socket.send(Message::Close(None)).await;
                break "runtime dropped";
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = socket.send(Message::Close(None)).await;
                    break "shutdown";
                }
            }
            _ = auth_tick.tick() => {
                let current_gen = *auth_generation.borrow();
                if !refresh_auth_session(&paths, &mut auth_session, current_gen).await {
                    let _ = socket.send(Message::Close(None)).await;
                    break "authentication expired";
                }
            }
            changed = auth_generation.changed() => {
                let current_gen = *auth_generation.borrow();
                if changed.is_err()
                    || !refresh_auth_session(&paths, &mut auth_session, current_gen).await
                {
                    let _ = socket.send(Message::Close(None)).await;
                    break "authentication changed";
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break "peer closed",
                    Some(Err(error)) => {
                        log::warn!(target: "remote-webui", "event socket read failed deviceId={} error={error}", auth_session.device.id);
                        break "socket read failed";
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break "pong send failed";
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        // Browser WebSockets cannot send native Ping frames.
                        if let Ok(message) = serde_json::from_str::<Value>(&text)
                            && message.get("type").and_then(Value::as_str) == Some("ping")
                            && send_ws_json(&mut socket, &json!({ "type": "pong" })).await.is_err()
                        {
                            break "pong send failed";
                        }
                    }
                    _ => {}
                }
            }
            received = receiver.recv() => {
                match received {
                    Ok(first) => {
                        if first.sequence <= snapshot_sequence {
                            continue;
                        }
                        match collect_event_batch(first, &mut receiver).await {
                            EventBatchResult::Ready(batch) => {
                                if send_event_batch(&mut socket, &batch).await.is_err() {
                                    break "event send failed";
                                }
                            }
                            EventBatchResult::Lagged => {
                                log::warn!(target: "remote-webui", "event batch lagged deviceId={} latestSequence={}", auth_session.device.id, events.latest_sequence());
                                if send_ws_json(
                                    &mut socket,
                                    &json!({ "type": "resyncRequired", "latestSequence": events.latest_sequence() }),
                                )
                                .await
                                .is_err()
                                {
                                    break "resync send failed";
                                }
                            }
                            EventBatchResult::Closed => break "event receiver closed",
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        log::warn!(target: "remote-webui", "event receiver lagged deviceId={} skipped={skipped} latestSequence={}", auth_session.device.id, events.latest_sequence());
                        if send_ws_json(
                            &mut socket,
                            &json!({ "type": "resyncRequired", "latestSequence": events.latest_sequence() }),
                        )
                        .await
                        .is_err()
                        {
                            break "resync send failed";
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break "event receiver closed",
                }
            }
        }
    };
    log::info!(target: "remote-webui", "event socket closed deviceId={} reason={close_reason} latestSequence={}", auth_session.device.id, events.latest_sequence());
}

enum EventBatchResult {
    Ready(Vec<Arc<SequencedRuntimeEvent>>),
    Lagged,
    Closed,
}

fn is_coalesceable_stream_event(event: &SequencedRuntimeEvent) -> bool {
    matches!(
        event.event.event,
        crate::events::RuntimeEvent::AssistantTextDelta { .. }
            | crate::events::RuntimeEvent::AssistantThinkingDelta { .. }
            | crate::events::RuntimeEvent::ToolExecutionUpdate { .. }
    )
}

async fn collect_event_batch(
    first: Arc<SequencedRuntimeEvent>,
    receiver: &mut crate::events::WebEventReceiver,
) -> EventBatchResult {
    let coalesce = is_coalesceable_stream_event(&first);
    let mut batch = vec![first];
    while batch.len() < WS_BATCH_MAX_EVENTS {
        match receiver.try_recv() {
            Ok(event) => batch.push(event),
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Lagged(_)) => return EventBatchResult::Lagged,
            Err(broadcast::error::TryRecvError::Closed) => return EventBatchResult::Closed,
        }
    }
    if !coalesce || batch.len() >= WS_BATCH_MAX_EVENTS {
        return EventBatchResult::Ready(batch);
    }
    let deadline = tokio::time::Instant::now() + WS_BATCH_WINDOW;
    while batch.len() < WS_BATCH_MAX_EVENTS {
        match tokio::time::timeout_at(deadline, receiver.recv()).await {
            Ok(Ok(event)) => {
                let keep_waiting = is_coalesceable_stream_event(&event);
                batch.push(event);
                if !keep_waiting {
                    break;
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                return EventBatchResult::Lagged;
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => {
                return EventBatchResult::Closed;
            }
            Err(_) => break,
        }
    }
    EventBatchResult::Ready(batch)
}

#[derive(Serialize)]
struct EventBatch<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    events: &'a [Arc<SequencedRuntimeEvent>],
}

async fn send_event_batch(
    socket: &mut WebSocket,
    events: &[Arc<SequencedRuntimeEvent>],
) -> Result<(), axum::Error> {
    // Serialize straight to text; a `json!` Value would deep-copy every payload.
    send_ws_json(
        socket,
        &EventBatch {
            kind: "events",
            events,
        },
    )
    .await
}

async fn send_ws_json<T: Serialize + ?Sized>(
    socket: &mut WebSocket,
    value: &T,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned());
    socket
        .send(Message::Text(text.into()))
        .await
        .inspect_err(|error| {
            log::warn!(target: "remote-webui", "event socket send failed error={error}");
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RuntimeEventBus;
    use crate::events::{PiProcessState, RuntimeEvent, RuntimeEventEnvelope};

    #[tokio::test]
    async fn event_batch_reports_lagged_receiver() {
        let bus = RuntimeEventBus::default();
        let mut receiver = bus.subscribe_web();
        bus.send(RuntimeEventEnvelope::session(
            "session".to_owned(),
            "project".to_owned(),
            RuntimeEvent::ProcessState {
                generation: 1,
                state: PiProcessState::Running,
            },
        ));
        let first = receiver.recv().await.expect("first event");

        for generation in 2..700 {
            bus.send(RuntimeEventEnvelope::session(
                "session".to_owned(),
                "project".to_owned(),
                RuntimeEvent::ProcessState {
                    generation,
                    state: PiProcessState::Running,
                },
            ));
        }

        assert!(matches!(
            collect_event_batch(first, &mut receiver).await,
            EventBatchResult::Lagged
        ));
    }
}
