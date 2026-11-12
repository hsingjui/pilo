use std::time::Duration;

use axum::{
    Extension,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message},
    },
    response::Response,
};
use serde::Deserialize;

use super::{AuthSession, RemoteHttpState};

#[derive(Deserialize)]
pub(super) struct ScreenQuery {
    display: Option<String>,
}

pub(super) async fn view(
    State(state): State<RemoteHttpState>,
    Extension(auth): Extension<AuthSession>,
    Query(query): Query<ScreenQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.protocols(["pilo"])
        .max_message_size(128)
        .max_frame_size(128)
        .on_upgrade(move |mut socket| async move {
            #[cfg(windows)]
            let reason = windows::stream(&mut socket, state, auth, query.display).await;
            #[cfg(not(windows))]
            let reason = {
                let _ = (state, auth, query.display);
                Some((4002, "unsupported"))
            };
            if let Some((code, reason)) = reason {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    socket.send(Message::Close(Some(CloseFrame {
                        code,
                        reason: reason.into(),
                    }))),
                )
                .await;
            }
        })
}

#[cfg(windows)]
mod windows {
    use axum::{body::Bytes, extract::ws::WebSocket};
    use serde_json::json;
    use tokio::time::{self, Instant, MissedTickBehavior};

    use super::{AuthSession, Duration, Message, RemoteHttpState};
    use crate::runtime::remote::{
        api::ws::remote_token_is_valid,
        screen_capture::{self, Capture},
    };

    const DISABLED: (u16, &str) = (4001, "disabled");
    const LOCKED: (u16, &str) = (4003, "locked");
    const DISPLAY_GONE: (u16, &str) = (4004, "display unavailable");
    const CAPTURE_FAILED: (u16, &str) = (4005, "capture failed");
    const BUSY: (u16, &str) = (4006, "busy");
    const UNAUTHORIZED: (u16, &str) = (4007, "authorization expired");
    const STALLED: (u16, &str) = (4008, "stream stalled");

    async fn send(socket: &mut WebSocket, message: Message) -> bool {
        time::timeout(Duration::from_secs(2), socket.send(message))
            .await
            .is_ok_and(|result| result.is_ok())
    }

    pub(super) async fn stream(
        socket: &mut WebSocket,
        state: RemoteHttpState,
        auth: AuthSession,
        selected: Option<String>,
    ) -> Option<(u16, &'static str)> {
        let mut enabled = state.screen_sharing.clone();
        let mut shutdown = state.shutdown.clone();
        let mut auth_generation = state.auth_generation.clone();
        if !*enabled.borrow_and_update() || *shutdown.borrow_and_update() {
            return Some(DISABLED);
        }
        if !screen_capture::desktop_unlocked() {
            return Some(LOCKED);
        }
        let slots = state.screen_slots.clone();
        let startup = async move {
            // A viewer switching displays may briefly overlap its old capture teardown.
            let permit = time::timeout(Duration::from_secs(2), slots.acquire_owned())
                .await
                .map_err(|_| BUSY)?
                .map_err(|_| BUSY)?;
            let capture = tokio::task::spawn_blocking(move || {
                let mut displays = screen_capture::displays().map_err(|_| CAPTURE_FAILED)?;
                let index = displays
                    .iter()
                    .position(|(display, _)| {
                        selected
                            .as_ref()
                            .map_or(display.primary, |id| id == &display.id)
                    })
                    .ok_or(DISPLAY_GONE)?;
                let metadata = json!({
                    "displays": displays.iter().map(|(display, _)| display).collect::<Vec<_>>(),
                    "selectedId": displays[index].0.id,
                });
                let (display, monitor) = displays.swap_remove(index);
                let (capture, frames) = Capture::start(monitor, permit).map_err(|error| {
                    log::warn!(target: "remote-webui", "failed to start screen capture: {error}");
                    CAPTURE_FAILED
                })?;
                if screen_capture::monitor_id(monitor).as_deref() != Some(display.id.as_str()) {
                    return Err(DISPLAY_GONE);
                }
                Ok((metadata, capture, frames))
            });
            match time::timeout(Duration::from_secs(8), capture).await {
                Ok(Ok(result)) => result,
                _ => Err(CAPTURE_FAILED),
            }
        };
        let (metadata, capture, mut frames) = tokio::select! {
            biased;
            _ = shutdown.changed() => return Some(DISABLED),
            _ = enabled.changed() => return Some(DISABLED),
            _ = socket.recv() => return None,
            result = startup => match result {
                Ok(started) => started,
                Err(reason) => return Some(reason),
            },
        };
        auth_generation.borrow_and_update();
        if !remote_token_is_valid(&state.paths, &auth.token).await {
            return Some(UNAUTHORIZED);
        }
        if enabled.has_changed().unwrap_or(true) || *shutdown.borrow() {
            return Some(DISABLED);
        }
        if !send(socket, Message::Text(metadata.to_string().into())).await {
            return None;
        }

        let started = Instant::now();
        let mut last_reply = started;
        let mut first_frame = false;
        let mut in_flight: Option<Instant> = None;
        let mut check = time::interval(Duration::from_millis(250));
        check.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut heartbeat =
            time::interval_at(started + Duration::from_secs(15), Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => return Some(DISABLED),
                _ = enabled.changed() => return Some(DISABLED),
                changed = auth_generation.changed() => {
                    if changed.is_err() || !remote_token_is_valid(&state.paths, &auth.token).await {
                        return Some(UNAUTHORIZED);
                    }
                }
                _ = check.tick() => {
                    if !screen_capture::desktop_unlocked() {
                        return Some(LOCKED);
                    }
                    if capture.is_finished() {
                        return Some(if first_frame { DISPLAY_GONE } else { CAPTURE_FAILED });
                    }
                    if auth.device.expires_at_ms <= crate::runtime::storage::now_ms() {
                        return Some(UNAUTHORIZED);
                    }
                    if in_flight.is_some_and(|sent| sent.elapsed() >= Duration::from_secs(6))
                        || last_reply.elapsed() >= Duration::from_secs(35)
                    {
                        return Some(STALLED);
                    }
                    if !first_frame && started.elapsed() >= Duration::from_secs(8) {
                        return Some(CAPTURE_FAILED);
                    }
                }
                _ = heartbeat.tick() => {
                    if !send(socket, Message::Ping(Bytes::new())).await {
                        return None;
                    }
                }
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Text(text))) if text.as_str() == "ack" && in_flight.is_some() => {
                        in_flight = None;
                        last_reply = Instant::now();
                    }
                    Some(Ok(Message::Pong(_))) => last_reply = Instant::now(),
                    Some(Ok(Message::Ping(_))) => {},
                    _ => return None,
                },
                // The capture mailbox keeps only the newest frame while the browser decodes.
                changed = frames.changed(), if in_flight.is_none() => {
                    let frame = frames.borrow_and_update().clone();
                    let (Ok(()), Some(frame)) = (changed, frame) else {
                        return Some(DISPLAY_GONE);
                    };
                    if !screen_capture::desktop_unlocked() {
                        return Some(LOCKED);
                    }
                    let remaining_ms = auth.device.expires_at_ms
                        .saturating_sub(crate::runtime::storage::now_ms());
                    if remaining_ms == 0 {
                        return Some(UNAUTHORIZED);
                    }
                    let expiry = time::sleep(Duration::from_millis(remaining_ms));
                    let write = send(socket, Message::Binary(frame));
                    tokio::pin!(expiry, write);
                    // Dropping the transport avoids flushing a partially written JPEG on close.
                    loop {
                        tokio::select! {
                            biased;
                            _ = shutdown.changed() => return None,
                            _ = enabled.changed() => return None,
                            _ = &mut expiry => return None,
                            changed = auth_generation.changed() => {
                                if changed.is_err() || !remote_token_is_valid(&state.paths, &auth.token).await {
                                    return None;
                                }
                            }
                            _ = check.tick() => {
                                if !screen_capture::desktop_unlocked() {
                                    return None;
                                }
                            }
                            sent = &mut write => {
                                if !sent {
                                    return None;
                                }
                                break;
                            }
                        }
                    }
                    first_frame = true;
                    in_flight = Some(Instant::now());
                }
            }
        }
    }
}
