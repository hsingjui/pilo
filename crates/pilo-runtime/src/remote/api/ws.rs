use std::{sync::Arc, time::Duration};

use axum::extract::ws::{Message, WebSocket};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{events::SequencedRuntimeEvent, host_paths::HostPaths, remote::auth};

use super::AuthSession;

const WS_BATCH_WINDOW: Duration = Duration::from_millis(16);
const WS_BATCH_MAX_EVENTS: usize = 64;

#[derive(Deserialize)]
pub(super) struct EventQuery {
    pub(super) after: Option<u64>,
}

pub(super) async fn refresh_auth_session(
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

pub(super) enum EventBatchResult {
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

pub(super) async fn collect_event_batch(
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

pub(super) async fn send_event_batch(
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

pub(super) async fn send_ws_json<T: Serialize + ?Sized>(
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
