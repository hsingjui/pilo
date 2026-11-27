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
    terminal::{TerminalManager, TerminalOwner},
};

use super::{
    AuthSession, HostRequest, RemoteHttpState,
    ws::{
        EventBatchResult, EventQuery, collect_event_batch, refresh_auth_session, send_event_batch,
        send_ws_json,
    },
};

pub const PROTOCOL_VERSION: &str = "2.0";
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
struct Capabilities<'a> {
    platform: &'static str,
    wsl: bool,
    methods: Vec<&'static str>,
    methods_hash: &'a str,
}

fn host_capabilities() -> Capabilities<'static> {
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
    }
}

fn v2_error(error: HostApiError) -> Response {
    let status = status_for_code(error.code);
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
    data: Bytes,
) -> Response {
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
}

impl DeviceWsGuard {
    fn new(terminals: TerminalManager, device_id: String) -> Self {
        terminals.on_device_ws_connected(&device_id);
        Self {
            terminals,
            device_id,
        }
    }
}

impl Drop for DeviceWsGuard {
    fn drop(&mut self) {
        self.terminals.on_device_ws_disconnected(&self.device_id);
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

    let _ws_guard = DeviceWsGuard::new(terminals.clone(), auth_session.device.id.clone());
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
            "scopes": auth_session.device.scopes.as_str(),
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

    let mut subscribed_terminals = HashSet::<String>::new();
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
                if auth_session.device.scopes != RemoteScopes::ChatWorkspace {
                    subscribed_terminals.clear();
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
                if auth_session.device.scopes != RemoteScopes::ChatWorkspace {
                    subscribed_terminals.clear();
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
                                if auth_session.device.scopes == RemoteScopes::ChatWorkspace
                                    && let Some(terminal_id) = message.get("terminalId").and_then(Value::as_str)
                                {
                                    let owner = TerminalOwner::Device(auth_session.device.id.clone());
                                    if terminals.owns(&owner, terminal_id) {
                                        subscribed_terminals.insert(terminal_id.to_owned());
                                    }
                                }
                            }
                            Some("terminal.unsubscribe") => {
                                if let Some(terminal_id) = message.get("terminalId").and_then(Value::as_str) {
                                    subscribed_terminals.remove(terminal_id);
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
                        TerminalEvent::Output { terminal_id, data } => {
                            let encoded = BASE64.encode(data);
                            (
                                terminal_id.clone(),
                                json!({
                                    "type": "terminal",
                                    "event": "output",
                                    "terminalId": terminal_id,
                                    "data": encoded,
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
                    if !subscribed_terminals.contains(&terminal_id) {
                        continue;
                    }
                    if finished {
                        subscribed_terminals.remove(&terminal_id);
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
mod tests {
    use std::path::PathBuf;

    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpStream,
    };

    use super::*;
    use crate::{
        Runtime,
        events::{PiProcessState, RuntimeEvent, RuntimeEventEnvelope},
        host_paths::HostPaths,
        initialize_local_server_binary,
    };

    struct TestHost {
        root: PathBuf,
        runtime: Runtime,
        port: u16,
    }

    fn pick_free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    impl TestHost {
        async fn start_ephemeral(label: &str) -> Self {
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "pilo-v2-e2e-{label}-{}-{}-{n}",
                std::process::id(),
                storage::now_ms()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let runtime =
                Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
            let port = pick_free_port();
            runtime.remote.set_port(&runtime, port).await.unwrap();
            let state = runtime.remote.set_enabled(&runtime, true).await.unwrap();
            assert!(state.running);
            assert_eq!(state.port, port);
            Self {
                root,
                runtime,
                port,
            }
        }

        async fn pair(&self, scopes: RemoteScopes, device_name: &str) -> (String, String) {
            let state = self
                .runtime
                .remote
                .regenerate_pairing(&self.runtime, scopes)
                .await
                .unwrap();
            let pairing_url = state.pairing_url.expect("pairing url");
            let secret = pairing_url
                .split("#pair=")
                .nth(1)
                .expect("pair secret")
                .to_owned();
            let (status, info) = http_json(
                self.port,
                "POST",
                "/api/v1/auth/pairing",
                None,
                None,
                &json!({ "secret": secret }),
            )
            .await;
            assert_eq!(status, 200, "pairing info failed: {info}");
            let address_id = info["addresses"][0]["id"]
                .as_str()
                .expect("address id")
                .to_owned();
            let mut digest = Sha256::new();
            digest.update(device_name.as_bytes());
            digest.update(storage::now_ms().to_le_bytes());
            let mut request_id = String::with_capacity(64);
            for byte in digest.finalize() {
                use std::fmt::Write;
                let _ = write!(&mut request_id, "{byte:02x}");
            }
            let (status, paired) = http_json(
                self.port,
                "POST",
                "/api/v1/auth/pair",
                None,
                None,
                &json!({
                    "secret": secret,
                    "addressId": address_id,
                    "requestId": request_id,
                    "deviceName": device_name,
                }),
            )
            .await;
            assert_eq!(status, 200, "pair failed: {paired}");
            (
                paired["token"].as_str().unwrap().to_owned(),
                paired["device"]["id"].as_str().unwrap().to_owned(),
            )
        }

        async fn cleanup(self) {
            self.runtime.shutdown().await;
            let _ = std::fs::remove_dir_all(self.root);
        }
    }

    async fn http_raw(
        port: u16,
        method: &str,
        path: &str,
        token: Option<&str>,
        origin: Option<&str>,
        content_type: Option<&str>,
        body: &[u8],
    ) -> (u16, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n",
            body.len()
        );
        if let Some(token) = token {
            req.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        if let Some(origin) = origin {
            req.push_str(&format!("Origin: {origin}\r\n"));
        }
        if let Some(ct) = content_type {
            req.push_str(&format!("Content-Type: {ct}\r\n"));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("http header separator");
        let headers = String::from_utf8_lossy(&raw[..split]);
        let status = headers
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u16>()
            .unwrap();
        (status, raw[split + 4..].to_vec())
    }

    async fn http_json(
        port: u16,
        method: &str,
        path: &str,
        token: Option<&str>,
        origin: Option<&str>,
        body: &Value,
    ) -> (u16, Value) {
        let encoded = serde_json::to_vec(body).unwrap();
        let (status, resp) = http_raw(
            port,
            method,
            path,
            token,
            origin,
            Some("application/json"),
            &encoded,
        )
        .await;
        let json = serde_json::from_slice(&resp)
            .unwrap_or_else(|_| json!({ "_raw": String::from_utf8_lossy(&resp).to_string() }));
        (status, json)
    }

    struct WsClient {
        reader: BufReader<TcpStream>,
    }

    impl WsClient {
        async fn connect(port: u16, path: &str, token: &str) -> Self {
            let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let mut reader = BufReader::new(stream);
            let upgrade = format!(
                "GET {path} HTTP/1.1\r\n\
                 Host: 127.0.0.1:{port}\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 Sec-WebSocket-Version: 13\r\n\
                 Sec-WebSocket-Protocol: pilo, pilo-token.{token}\r\n\r\n"
            );
            reader
                .get_mut()
                .write_all(upgrade.as_bytes())
                .await
                .unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(line.trim(), "HTTP/1.1 101 Switching Protocols");
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
            }
            Self { reader }
        }

        async fn send_text(&mut self, value: &Value) {
            let payload = serde_json::to_vec(value).unwrap();
            let mask = [0x12u8, 0x34, 0x56, 0x78];
            let mut frame = Vec::with_capacity(14 + payload.len());
            frame.push(0x81);
            if payload.len() <= 125 {
                frame.push(0x80 | (payload.len() as u8));
            } else if payload.len() <= 65535 {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            for (index, byte) in payload.iter().enumerate() {
                frame.push(byte ^ mask[index % 4]);
            }
            self.reader.get_mut().write_all(&frame).await.unwrap();
        }

        async fn recv_frame(&mut self) -> Option<(u8, Vec<u8>)> {
            let mut header = [0u8; 2];
            if self.reader.read_exact(&mut header).await.is_err() {
                return None;
            }
            let opcode = header[0] & 0x0f;
            let len_byte = header[1] & 0x7f;
            let len = match len_byte {
                0..=125 => usize::from(len_byte),
                126 => {
                    let mut ext = [0u8; 2];
                    self.reader.read_exact(&mut ext).await.ok()?;
                    usize::from(u16::from_be_bytes(ext))
                }
                127 => {
                    let mut ext = [0u8; 8];
                    self.reader.read_exact(&mut ext).await.ok()?;
                    usize::try_from(u64::from_be_bytes(ext)).ok()?
                }
                _ => unreachable!(),
            };
            let mut payload = vec![0u8; len];
            self.reader.read_exact(&mut payload).await.ok()?;
            Some((opcode, payload))
        }

        async fn recv_json(&mut self) -> Value {
            let (opcode, payload) = tokio::time::timeout(Duration::from_secs(5), self.recv_frame())
                .await
                .expect("ws recv timeout")
                .expect("ws closed unexpectedly");
            assert_eq!(opcode, 0x1, "expected text frame, got opcode {opcode}");
            serde_json::from_slice(&payload).unwrap()
        }

        async fn expect_closed(&mut self) {
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                while let Some((opcode, _)) = self.recv_frame().await {
                    if opcode == 0x8 {
                        return true;
                    }
                }
                true
            })
            .await
            .expect("ws did not close in time");
            assert!(closed);
        }
    }

    fn locate_pilo_server_binary() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let target_dir = exe.ancestors().find(|p| {
            p.file_name()
                .is_some_and(|n| n == "debug" || n == "release")
        })?;
        let candidate = target_dir.join(if cfg!(windows) {
            "pilo-server.exe"
        } else {
            "pilo-server"
        });
        candidate.is_file().then_some(candidate)
    }

    #[tokio::test]
    async fn v2_dual_host_pairing_calls_scopes_origin_and_event_replay() {
        let host_a = TestHost::start_ephemeral("host-a").await;
        let host_b = TestHost::start_ephemeral("host-b").await;
        assert_ne!(host_a.port, host_b.port);

        let (token_a, _) = host_a.pair(RemoteScopes::Chat, "HostA-Client").await;
        let (token_b_chat, device_b_chat) = host_b.pair(RemoteScopes::Chat, "HostB-Chat").await;
        let (token_b_ws, _) = host_b
            .pair(RemoteScopes::ChatWorkspace, "HostB-Workspace")
            .await;

        // Distinct persisted hostIds across Host A and Host B.
        let mut ws_a = WsClient::connect(host_a.port, "/api/v2/events", &token_a).await;
        let hello_a = ws_a.recv_json().await;
        assert_eq!(hello_a["type"], "hello");
        assert_eq!(hello_a["protocolVersion"], PROTOCOL_VERSION);

        let mut ws_b = WsClient::connect(host_b.port, "/api/v2/events", &token_b_chat).await;
        let hello_b = ws_b.recv_json().await;
        assert_eq!(hello_b["type"], "hello");
        assert_eq!(hello_b["deviceId"], device_b_chat);
        assert_eq!(hello_b["scopes"], "chat");
        assert_eq!(hello_b["protocolVersion"], PROTOCOL_VERSION);
        assert_ne!(hello_a["hostId"], hello_b["hostId"]);
        assert!(hello_b["hostName"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(
            hello_b["capabilities"]["methods"]
                .as_array()
                .is_some_and(|m| !m.is_empty())
        );
        assert_eq!(hello_b["capabilities"]["methodsHash"], methods_hash());

        // Ping -> Pong.
        ws_b.send_text(&json!({ "type": "ping" })).await;
        assert_eq!(ws_b.recv_json().await["type"], "pong");

        // Chat scope can call bootstrap & read-only connections (no credentials).
        let (status, bootstrap) = http_json(
            host_b.port,
            "POST",
            "/api/v2/call/host.bootstrap",
            Some(&token_b_chat),
            None,
            &json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(bootstrap["ok"], true);

        let (status, connections) = http_json(
            host_b.port,
            "POST",
            "/api/v2/call/connection.list",
            Some(&token_b_chat),
            None,
            &json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(connections["ok"], true);
        assert!(
            connections["result"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        );

        // Scope enforcement: Chat denied workspace & admin; Workspace denied admin.
        let (status, err) = http_json(
            host_b.port,
            "POST",
            "/api/v2/call/project.add",
            Some(&token_b_chat),
            None,
            &json!({ "connectionId": "local", "path": host_b.root }),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"]["code"], "forbidden");

        let (status, err) = http_json(
            host_b.port,
            "POST",
            "/api/v2/call/connection.ssh.password",
            Some(&token_b_ws),
            None,
            &json!({ "id": "ssh:test" }),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"]["code"], "forbidden");

        let (status, err) = http_json(
            host_b.port,
            "POST",
            "/api/v2/call/host.shutdown",
            Some(&token_b_ws),
            None,
            &json!({}),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(err["error"]["code"], "forbidden");

        // Origin enforcement.
        let (status, _) = http_json(
            host_b.port,
            "POST",
            "/api/v2/call/host.bootstrap",
            Some(&token_b_chat),
            Some("https://evil.example"),
            &json!({}),
        )
        .await;
        assert_eq!(status, 403);

        // Event live delivery + disconnect + replay after=<seq>.
        host_b.runtime.events.send(RuntimeEventEnvelope::session(
            "s1".to_owned(),
            "p1".to_owned(),
            RuntimeEvent::ProcessState {
                generation: 1,
                state: PiProcessState::Running,
            },
        ));
        let live_batch = ws_b.recv_json().await;
        assert_eq!(live_batch["type"], "events");
        let seq1 = live_batch["events"][0]["sequence"].as_u64().unwrap();
        drop(ws_b);

        host_b.runtime.events.send(RuntimeEventEnvelope::session(
            "s1".to_owned(),
            "p1".to_owned(),
            RuntimeEvent::ProcessState {
                generation: 2,
                state: PiProcessState::Stopped,
            },
        ));
        let mut ws_b_reconnected = WsClient::connect(
            host_b.port,
            &format!("/api/v2/events?after={seq1}"),
            &token_b_chat,
        )
        .await;
        let hello2 = ws_b_reconnected.recv_json().await;
        assert_eq!(hello2["type"], "hello");
        assert_eq!(hello2["hostId"], hello_b["hostId"]);
        let replayed = ws_b_reconnected.recv_json().await;
        assert_eq!(replayed["type"], "events");
        assert_eq!(replayed["events"].as_array().unwrap().len(), 1);
        assert_eq!(replayed["events"][0]["generation"], 2);

        drop(ws_a);
        drop(ws_b_reconnected);
        host_a.cleanup().await;
        host_b.cleanup().await;
    }

    #[tokio::test]
    async fn v2_terminal_ownership_disconnect_retention_snapshot_toggle_and_revoke() {
        let Some(server_bin) = locate_pilo_server_binary() else {
            panic!("pilo-server binary not found; run `cargo build -p pilo-server` first");
        };
        initialize_local_server_binary(server_bin);

        let host = TestHost::start_ephemeral("term").await;
        host.runtime
            .terminals
            .set_disconnect_retention(Duration::from_secs(5));

        let (token_dev1, dev1_id) = host.pair(RemoteScopes::ChatWorkspace, "Dev1").await;
        let (token_dev2, _) = host.pair(RemoteScopes::ChatWorkspace, "Dev2").await;

        let project_dir = host.root.join("proj");
        std::fs::create_dir_all(&project_dir).unwrap();
        let (status, added) = http_json(
            host.port,
            "POST",
            "/api/v2/call/project.add",
            Some(&token_dev1),
            None,
            &json!({ "connectionId": "local", "path": project_dir }),
        )
        .await;
        assert_eq!(status, 200, "project.add failed: {added}");
        let project_id = added["result"]["id"].as_str().unwrap().to_owned();

        // Open terminal as Dev1 and subscribe on v2 WS.
        let mut ws1 = WsClient::connect(host.port, "/api/v2/events", &token_dev1).await;
        let _hello = ws1.recv_json().await;

        let (status, opened) = http_json(
            host.port,
            "POST",
            "/api/v2/call/terminal.open",
            Some(&token_dev1),
            None,
            &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
        )
        .await;
        assert_eq!(status, 200, "terminal.open failed: {opened}");
        let terminal_id = opened["result"]["id"].as_str().unwrap().to_owned();

        ws1.send_text(&json!({ "type": "terminal.subscribe", "terminalId": terminal_id }))
            .await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Dev2 cannot access Dev1's terminal.
        let (status, err) = http_json(
            host.port,
            "POST",
            "/api/v2/call/terminal.snapshot",
            Some(&token_dev2),
            None,
            &json!({ "terminalId": terminal_id }),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(err["error"]["code"], "forbidden");

        // Write via /api/v2/upload/terminal.write and receive output over WS.
        let (status, _) = http_raw(
            host.port,
            "POST",
            &format!("/api/v2/upload/terminal.write?terminalId={terminal_id}"),
            Some(&token_dev1),
            None,
            Some("application/octet-stream"),
            b"echo PILO_V2_LIVE_MARKER\n",
        )
        .await;
        assert_eq!(status, 200);

        let mut received = String::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !received.contains("PILO_V2_LIVE_MARKER") {
                let msg = ws1.recv_json().await;
                if msg["type"] == "terminal"
                    && msg["event"] == "output"
                    && msg["terminalId"] == terminal_id
                    && let Some(data) = msg["data"].as_str()
                    && let Ok(bytes) = BASE64.decode(data)
                {
                    received.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
        })
        .await
        .expect("did not receive live terminal output over v2 WS");

        // Disconnect WS -> PTY stays alive during retention window -> write while disconnected ->
        // reconnect -> terminal.attach + terminal.snapshot recovers buffered output.
        drop(ws1);
        tokio::time::sleep(Duration::from_millis(100)).await;

        let (status, _) = http_raw(
            host.port,
            "POST",
            &format!("/api/v2/upload/terminal.write?terminalId={terminal_id}"),
            Some(&token_dev1),
            None,
            Some("application/octet-stream"),
            b"echo PILO_V2_RECONNECT_MARKER\n",
        )
        .await;
        assert_eq!(status, 200);

        let mut ws1_reconnected = WsClient::connect(host.port, "/api/v2/events", &token_dev1).await;
        let _hello = ws1_reconnected.recv_json().await;
        let (status, attached) = http_json(
            host.port,
            "POST",
            "/api/v2/call/terminal.attach",
            Some(&token_dev1),
            None,
            &json!({ "terminalId": terminal_id }),
        )
        .await;
        assert_eq!(status, 200, "terminal.attach failed: {attached}");

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (status, snap) = http_json(
                    host.port,
                    "POST",
                    "/api/v2/call/terminal.snapshot",
                    Some(&token_dev1),
                    None,
                    &json!({ "terminalId": terminal_id }),
                )
                .await;
                assert_eq!(status, 200);
                let bytes = BASE64
                    .decode(snap["result"]["data"].as_str().unwrap())
                    .unwrap();
                let text = String::from_utf8_lossy(&bytes);
                if text.contains("PILO_V2_RECONNECT_MARKER") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("terminal.snapshot did not include reconnect marker");

        // Disabling remote access closes WS and closes remote-owned terminals.
        let disabled = host
            .runtime
            .remote
            .set_enabled(&host.runtime, false)
            .await
            .unwrap();
        assert!(!disabled.running);
        ws1_reconnected.expect_closed().await;
        assert!(
            !host
                .runtime
                .terminals
                .owns(&TerminalOwner::Device(dev1_id.clone()), &terminal_id)
        );

        // Re-enable remote access, open another terminal, verify revoke closes WS & terminal.
        let reenabled = host
            .runtime
            .remote
            .set_enabled(&host.runtime, true)
            .await
            .unwrap();
        assert!(reenabled.running);
        let mut ws_rev = WsClient::connect(reenabled.port, "/api/v2/events", &token_dev1).await;
        let _hello = ws_rev.recv_json().await;
        let (status, opened2) = http_json(
            reenabled.port,
            "POST",
            "/api/v2/call/terminal.open",
            Some(&token_dev1),
            None,
            &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
        )
        .await;
        assert_eq!(status, 200);
        let term2 = opened2["result"]["id"].as_str().unwrap().to_owned();
        assert!(
            host.runtime
                .terminals
                .owns(&TerminalOwner::Device(dev1_id.clone()), &term2)
        );

        host.runtime
            .remote
            .revoke_device(&host.runtime, &dev1_id)
            .await
            .unwrap();
        ws_rev.expect_closed().await;
        assert!(
            !host
                .runtime
                .terminals
                .owns(&TerminalOwner::Device(dev1_id), &term2)
        );

        // Short retention expiry test with Dev2.
        host.runtime
            .terminals
            .set_disconnect_retention(Duration::from_millis(120));
        let ws2 = WsClient::connect(reenabled.port, "/api/v2/events", &token_dev2).await;
        let (status, opened3) = http_json(
            reenabled.port,
            "POST",
            "/api/v2/call/terminal.open",
            Some(&token_dev2),
            None,
            &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
        )
        .await;
        assert_eq!(status, 200);
        let term3 = opened3["result"]["id"].as_str().unwrap().to_owned();
        drop(ws2);
        tokio::time::sleep(Duration::from_millis(350)).await;
        let (status, err) = http_json(
            reenabled.port,
            "POST",
            "/api/v2/call/terminal.attach",
            Some(&token_dev2),
            None,
            &json!({ "terminalId": term3 }),
        )
        .await;
        assert_eq!(status, 404);
        assert_eq!(err["error"]["code"], "not_found");

        host.cleanup().await;
    }
}
