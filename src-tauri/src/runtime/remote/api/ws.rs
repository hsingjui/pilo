use std::time::Duration;

use axum::{
    extract::{
        Extension, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::Manager;
use tokio::sync::broadcast;

use crate::runtime::{
    RuntimeEventBus, events::SequencedRuntimeEvent, host_paths::HostPaths, remote::auth,
};

use super::{AuthSession, RemoteHttpState};

const WS_BATCH_WINDOW: Duration = Duration::from_millis(16);
const WS_BATCH_MAX_EVENTS: usize = 64;

#[derive(Deserialize)]
pub(super) struct EventQuery {
    after: Option<u64>,
}

pub(super) async fn events(
    State(state): State<RemoteHttpState>,
    Extension(auth_session): Extension<AuthSession>,
    Query(query): Query<EventQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.protocols(["pilo"])
        .on_upgrade(move |socket| event_socket(socket, state, auth_session, query.after))
}

async fn remote_token_is_valid(paths: &HostPaths, token: &str) -> bool {
    let paths = paths.clone();
    let token = token.to_owned();
    tokio::task::spawn_blocking(move || auth::authenticate(&paths, &token))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
        .is_some()
}

async fn event_socket(
    mut socket: WebSocket,
    state: RemoteHttpState,
    auth_session: AuthSession,
    after: Option<u64>,
) {
    let events = state.app.state::<RuntimeEventBus>().inner().clone();
    let mut receiver = events.subscribe_web();
    let snapshot_sequence = events.latest_sequence();

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

    let mut shutdown = state.shutdown.clone();
    let mut auth_generation = state.auth_generation.clone();
    let mut auth_tick = tokio::time::interval(Duration::from_secs(15));
    auth_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    auth_tick.tick().await;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            _ = auth_tick.tick() => {
                if !remote_token_is_valid(&state.paths, &auth_session.token).await {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            changed = auth_generation.changed() => {
                if changed.is_err()
                    || !remote_token_is_valid(&state.paths, &auth_session.token).await
                {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break;
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
                                    break;
                                }
                            }
                            EventBatchResult::Lagged => {
                                if send_ws_json(
                                    &mut socket,
                                    &json!({ "type": "resyncRequired", "latestSequence": events.latest_sequence() }),
                                )
                                .await
                                .is_err()
                                {
                                    break;
                                }
                            }
                            EventBatchResult::Closed => break,
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if send_ws_json(
                            &mut socket,
                            &json!({ "type": "resyncRequired", "latestSequence": events.latest_sequence() }),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

enum EventBatchResult {
    Ready(Vec<SequencedRuntimeEvent>),
    Lagged,
    Closed,
}

async fn collect_event_batch(
    first: SequencedRuntimeEvent,
    receiver: &mut broadcast::Receiver<SequencedRuntimeEvent>,
) -> EventBatchResult {
    let mut batch = vec![first];
    let deadline = tokio::time::Instant::now() + WS_BATCH_WINDOW;
    while batch.len() < WS_BATCH_MAX_EVENTS {
        match tokio::time::timeout_at(deadline, receiver.recv()).await {
            Ok(Ok(event)) => batch.push(event),
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

async fn send_event_batch(
    socket: &mut WebSocket,
    events: &[SequencedRuntimeEvent],
) -> Result<(), axum::Error> {
    send_ws_json(socket, &json!({ "type": "events", "events": events })).await
}

async fn send_ws_json(socket: &mut WebSocket, value: &Value) -> Result<(), axum::Error> {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned());
    socket.send(Message::Text(text.into())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::events::{PiProcessState, RuntimeEvent, RuntimeEventEnvelope};

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
