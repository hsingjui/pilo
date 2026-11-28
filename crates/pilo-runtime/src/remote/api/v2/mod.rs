use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
    time::Duration,
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{
        Extension, Path, Query, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use pilo_domain::RemoteScopes;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::{
    TERMINAL_QUEUE_MAX_BYTES, TerminalEvent,
    events::LIVE_IMAGE_PREFIX,
    host_api::{self, BinaryOutput, ErrorCode, HostApiError},
    storage,
    terminal::{TerminalAccessError, TerminalManager, TerminalOwner},
};

use super::{
    AuthSession, HostRequest, RemoteHttpState,
    ws::{
        EventBatchResult, EventQuery, collect_event_batch, refresh_auth_session, send_event_batch,
        send_ws_json,
    },
};

pub use crate::host_api::PROTOCOL_VERSION;
const WS_BATCH_MAX_EVENTS: usize = 64;
const WS_TERMINAL_BATCH_MAX_EVENTS: usize = 32;

fn host_name() -> &'static str {
    static HOST_NAME: OnceLock<String> = OnceLock::new();
    HOST_NAME
        .get_or_init(|| {
            for key in ["HOSTNAME", "COMPUTERNAME"] {
                if let Ok(value) = std::env::var(key) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_owned();
                    }
                }
            }
            #[cfg(unix)]
            if let Ok(output) = std::process::Command::new("hostname").output()
                && output.status.success()
                && let Ok(name) = String::from_utf8(output.stdout)
            {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_owned();
                }
            }
            "Pilo Host".to_owned()
        })
        .as_str()
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub(crate) fn methods_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        let mut hasher = Sha256::new();
        for spec in host_api::methods() {
            hasher.update(spec.name.as_bytes());
            hasher.update(b":");
            hasher.update(
                serde_json::to_string(&spec.scope)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            hasher.update(b":");
            hasher.update(
                serde_json::to_string(&spec.kind)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            hasher.update(b"\n");
        }
        let digest = hasher.finalize();
        let mut out = String::with_capacity(digest.len() * 2);
        for byte in digest {
            use std::fmt::Write;
            let _ = write!(&mut out, "{byte:02x}");
        }
        out
    })
    .as_str()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities<'a> {
    platform: &'static str,
    wsl: bool,
    methods: Vec<&'static str>,
    methods_hash: &'a str,
}

pub(crate) fn host_capabilities() -> Capabilities<'static> {
    Capabilities {
        platform: platform_name(),
        wsl: cfg!(target_os = "windows"),
        methods: host_api::methods().iter().map(|spec| spec.name).collect(),
        methods_hash: methods_hash(),
    }
}

fn status_for_code(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        ErrorCode::Forbidden => StatusCode::FORBIDDEN,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::InvalidParams => StatusCode::BAD_REQUEST,
        ErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        ErrorCode::Timeout => StatusCode::REQUEST_TIMEOUT,
        ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        ErrorCode::Conflict => StatusCode::CONFLICT,
        ErrorCode::OutcomeUnknown => StatusCode::BAD_GATEWAY,
    }
}

fn v2_error(error: HostApiError) -> Response {
    let status = if error.too_large {
        StatusCode::PAYLOAD_TOO_LARGE
    } else {
        status_for_code(error.code)
    };
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

fn query_to_json(query: HashMap<String, String>) -> Result<Value, HostApiError> {
    let mut map = Map::with_capacity(query.len());
    for (key, value) in query {
        if key == "expectedFileSize" {
            let parsed = value
                .parse::<u64>()
                .map_err(|_| HostApiError::invalid("expectedFileSize must be an integer"))?;
            map.insert(key, Value::from(parsed));
        } else {
            map.insert(key, Value::String(value));
        }
    }
    Ok(Value::Object(map))
}

pub(super) async fn call(host: HostRequest, Path(method): Path<String>, body: Bytes) -> Response {
    let params = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(value) => value,
            Err(error) => {
                return v2_error(HostApiError::invalid(format!("invalid JSON body: {error}")));
            }
        }
    };
    match host_api::call_json_bytes(&host.runtime, &host.principal, &method, params).await {
        Ok(result_bytes) => {
            let mut envelope = Vec::with_capacity(22 + result_bytes.len());
            envelope.extend_from_slice(br#"{"ok":true,"result":"#);
            envelope.extend_from_slice(&result_bytes);
            envelope.push(b'}');
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(envelope))
                .unwrap_or_else(|error| v2_error(HostApiError::internal(error.to_string())))
        }
        Err(error) => v2_error(error),
    }
}

pub(super) async fn upload(
    host: HostRequest,
    Path(method): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: Body,
) -> Response {
    let Some(spec) = host_api::methods().iter().find(|spec| spec.name == method) else {
        return v2_error(HostApiError::not_found(format!(
            "Unknown Host API method '{method}'"
        )));
    };
    if !host.principal.allows(spec.scope) {
        return v2_error(HostApiError::new(
            ErrorCode::Forbidden,
            format!("Access to '{method}' is forbidden"),
        ));
    }
    let Some(limit) = spec.limits.max_binary_input_bytes else {
        return v2_error(HostApiError::invalid(format!(
            "Invalid request kind for '{method}'"
        )));
    };
    let data = match axum::body::to_bytes(body, limit).await {
        Ok(bytes) => bytes,
        Err(_) => {
            let message = if method == "chat.files.upload" {
                "chat attachment exceeds the 10 MB limit".to_owned()
            } else {
                format!("'{method}' binary input exceeds {limit} bytes")
            };
            return v2_error(HostApiError::too_large(message));
        }
    };
    let params = match query_to_json(query) {
        Ok(params) => params,
        Err(error) => return v2_error(error),
    };
    match host.binary(&method, params, Some(&data)).await {
        Ok(BinaryOutput::Json(value)) => {
            Json(json!({ "ok": true, "result": value })).into_response()
        }
        Ok(BinaryOutput::Bytes(_)) => {
            v2_error(HostApiError::internal("expected JSON result from upload"))
        }
        Err(error) => v2_error(error),
    }
}

pub(super) async fn blob(
    host: HostRequest,
    Path(method): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let cache_control = if method == "session.historyImage"
        && query
            .get("imageId")
            .is_some_and(|id| !id.starts_with(LIVE_IMAGE_PREFIX))
    {
        "private, max-age=31536000, immutable"
    } else {
        "no-store"
    };
    let params = match query_to_json(query) {
        Ok(params) => params,
        Err(error) => return v2_error(error),
    };
    match host.binary(&method, params, None).await {
        Ok(BinaryOutput::Bytes(bytes)) if bytes.len() > host_api::MAX_BLOB_OUTPUT_BYTES => {
            v2_error(HostApiError::too_large(format!(
                "'{method}' binary output exceeds {} bytes",
                host_api::MAX_BLOB_OUTPUT_BYTES
            )))
        }
        Ok(BinaryOutput::Bytes(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CACHE_CONTROL, cache_control)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Body::from(bytes))
            .unwrap_or_else(|error| v2_error(HostApiError::internal(error.to_string()))),
        Ok(BinaryOutput::Json(_)) => {
            v2_error(HostApiError::internal("expected binary output from blob"))
        }
        Err(error) => v2_error(error),
    }
}

struct DeviceWsGuard {
    terminals: TerminalManager,
    device_id: String,
    subscribed: HashSet<String>,
}

impl DeviceWsGuard {
    fn new(terminals: TerminalManager, device_id: String) -> Self {
        terminals.on_device_ws_connected(&device_id);
        Self {
            terminals,
            device_id,
            subscribed: HashSet::new(),
        }
    }

    fn subscribe(&mut self, terminal_id: &str) -> Option<Result<u64, TerminalAccessError>> {
        if self.subscribed.contains(terminal_id) {
            return None;
        }
        let owner = TerminalOwner::Device(self.device_id.clone());
        let result = self.terminals.subscribe_ws(&owner, terminal_id);
        if result.is_ok() {
            self.subscribed.insert(terminal_id.to_owned());
        }
        Some(result)
    }

    fn unsubscribe(&mut self, terminal_id: &str) {
        if self.subscribed.remove(terminal_id) {
            let owner = TerminalOwner::Device(self.device_id.clone());
            self.terminals.unsubscribe_ws(&owner, terminal_id);
        }
    }

    fn contains(&self, terminal_id: &str) -> bool {
        self.subscribed.contains(terminal_id)
    }

    fn finish_terminal(&mut self, terminal_id: &str) {
        self.subscribed.remove(terminal_id);
    }
}

impl Drop for DeviceWsGuard {
    fn drop(&mut self) {
        self.terminals
            .on_device_ws_disconnected(&self.device_id, self.subscribed.iter().map(String::as_str));
    }
}

pub(super) async fn events(
    state: RemoteHttpState,
    Extension(auth_session): Extension<AuthSession>,
    Query(query): Query<EventQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.protocols(["pilo"])
        .on_upgrade(move |socket| event_socket_v2(socket, state, auth_session, query.after))
}

async fn event_socket_v2(
    mut socket: WebSocket,
    state: RemoteHttpState,
    mut auth_session: AuthSession,
    after: Option<u64>,
) {
    let events = state.runtime.events.clone();
    let terminals = state.runtime.terminals.clone();
    let terminal_events = state
        .runtime
        .subscribe_terminal_events(TERMINAL_QUEUE_MAX_BYTES);
    let paths = state.runtime.paths.clone();
    let mut lifetime = state.runtime.downgrade();
    let mut shutdown = state.shutdown.clone();
    let mut auth_generation = state.auth_generation.clone();
    drop(state);

    let mut ws_guard = DeviceWsGuard::new(terminals.clone(), auth_session.device.id.clone());
    let host_id = {
        let paths = paths.clone();
        match tokio::task::spawn_blocking(move || {
            let db = storage::open_with_paths(&paths)?;
            storage::get_or_create_host_id(&db)
        })
        .await
        {
            Ok(Ok(id)) => id,
            Ok(Err(error)) => {
                log::warn!(target: "remote-v2", "failed to load hostId: {error}");
                let _ = socket.send(Message::Close(None)).await;
                return;
            }
            Err(error) => {
                log::warn!(target: "remote-v2", "hostId task failed: {error}");
                let _ = socket.send(Message::Close(None)).await;
                return;
            }
        }
    };

    let mut receiver = events.subscribe_web();
    let snapshot_sequence = events.latest_sequence();
    let scopes = auth_session.device.scopes;
    log::info!(
        target: "remote-v2",
        "v2 event socket opened deviceId={} after={after:?} latestSequence={snapshot_sequence}",
        auth_session.device.id
    );

    if send_ws_json(
        &mut socket,
        &json!({
            "type": "hello",
            "hostId": host_id,
            "hostName": host_name(),
            "deviceId": auth_session.device.id,
            "protocolVersion": PROTOCOL_VERSION,
            "scopes": scopes.as_str(),
            "latestSequence": snapshot_sequence,
            "capabilities": host_capabilities(),
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
                log::warn!(
                    target: "remote-v2",
                    "event replay gap deviceId={} after={after} latestSequence={snapshot_sequence}",
                    auth_session.device.id
                );
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
                if auth_session.device.scopes != scopes {
                    let _ = socket.send(Message::Close(None)).await;
                    break "device scopes changed";
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
                if auth_session.device.scopes != scopes {
                    let _ = socket.send(Message::Close(None)).await;
                    break "device scopes changed";
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break "peer closed",
                    Some(Err(error)) => {
                        log::warn!(target: "remote-v2", "event socket read failed deviceId={} error={error}", auth_session.device.id);
                        break "socket read failed";
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break "pong send failed";
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        match message.get("type").and_then(Value::as_str) {
                            Some("ping") => {
                                if send_ws_json(&mut socket, &json!({ "type": "pong" })).await.is_err() {
                                    break "pong send failed";
                                }
                            }
                            Some("terminal.subscribe") => {
                                if let Some(terminal_id) = message.get("terminalId").and_then(Value::as_str) {
                                    let result = if auth_session.device.scopes == RemoteScopes::ChatWorkspace {
                                        ws_guard.subscribe(terminal_id)
                                    } else {
                                        Some(Err(TerminalAccessError::Forbidden("workspace scope is required".into())))
                                    };
                                    if message["ack"] == true && let Some(result) = result {
                                        let mut ack = json!({ "type": "terminal.subscribed", "terminalId": terminal_id });
                                        match result {
                                            Ok(offset) => ack["offset"] = json!(offset),
                                            Err(error) => {
                                                let code = match error {
                                                    TerminalAccessError::NotFound(_) => ErrorCode::NotFound,
                                                    TerminalAccessError::Forbidden(_) => ErrorCode::Forbidden,
                                                    TerminalAccessError::Internal(_) => ErrorCode::Internal,
                                                };
                                                ack["error"] = json!(HostApiError::new(code, error.into_message()));
                                            }
                                        }
                                        if send_ws_json(&mut socket, &ack).await.is_err() {
                                            break "terminal subscription acknowledgement failed";
                                        }
                                    }
                                }
                            }
                            Some("terminal.unsubscribe") => {
                                if let Some(terminal_id) = message.get("terminalId").and_then(Value::as_str) {
                                    ws_guard.unsubscribe(terminal_id);
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            term_batch = terminal_events.next_batch(WS_TERMINAL_BATCH_MAX_EVENTS) => {
                if term_batch.is_empty() {
                    let _ = socket.send(Message::Close(None)).await;
                    break "terminal stream closed";
                }
                let mut send_failed = false;
                for event in term_batch {
                    let (terminal_id, payload, finished) = match event {
                        TerminalEvent::Output { terminal_id, data, start_offset } => {
                            let encoded = BASE64.encode(data);
                            (
                                terminal_id.clone(),
                                json!({
                                    "type": "terminal",
                                    "event": "output",
                                    "terminalId": terminal_id,
                                    "data": encoded,
                                    "startOffset": start_offset,
                                }),
                                false,
                            )
                        }
                        TerminalEvent::Exit { terminal_id } => (
                            terminal_id.clone(),
                            json!({
                                "type": "terminal",
                                "event": "exit",
                                "terminalId": terminal_id,
                            }),
                            true,
                        ),
                        TerminalEvent::Error { terminal_id, message } => (
                            terminal_id.clone(),
                            json!({
                                "type": "terminal",
                                "event": "error",
                                "terminalId": terminal_id,
                                "message": message,
                            }),
                            true,
                        ),
                    };
                    if !ws_guard.contains(&terminal_id) {
                        continue;
                    }
                    if finished {
                        ws_guard.finish_terminal(&terminal_id);
                    }
                    if send_ws_json(&mut socket, &payload).await.is_err() {
                        send_failed = true;
                        break;
                    }
                }
                if send_failed {
                    break "terminal event send failed";
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
                                log::warn!(target: "remote-v2", "event batch lagged deviceId={} latestSequence={}", auth_session.device.id, events.latest_sequence());
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
                        log::warn!(target: "remote-v2", "event receiver lagged deviceId={} skipped={skipped} latestSequence={}", auth_session.device.id, events.latest_sequence());
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
    log::info!(
        target: "remote-v2",
        "v2 event socket closed deviceId={} reason={close_reason} latestSequence={}",
        auth_session.device.id,
        events.latest_sequence()
    );
}

#[cfg(test)]
mod tests;
