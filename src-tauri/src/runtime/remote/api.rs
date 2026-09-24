use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{
        ConnectInfo, DefaultBodyLimit, Extension, Query, Request, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, watch};
use tower_http::timeout::TimeoutLayer;

use crate::{
    domain::{Project, RemoteDevice},
    runtime::{
        PiloRuntime, RuntimeEventBus,
        chat_service::{self, ChatSessionRequest},
        events::SequencedRuntimeEvent,
        host_paths::HostPaths,
        pi_workspace, remote_fs, session_history, session_index, storage,
    },
};

use super::auth;

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_CHAT_IMAGES: usize = 8;
const MAX_CHAT_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHAT_IMAGE_TOTAL_BYTES: usize = 20 * 1024 * 1024;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
const AUTH_FAILURE_LIMIT: usize = 5;
const WS_BATCH_WINDOW: Duration = Duration::from_millis(16);
const WS_BATCH_MAX_EVENTS: usize = 64;

#[derive(Clone)]
pub(crate) struct RemoteHttpState {
    app: AppHandle,
    paths: HostPaths,
    rate_limiter: Arc<AuthRateLimiter>,
    shutdown: watch::Receiver<bool>,
    auth_generation: watch::Receiver<u64>,
}

#[derive(Default)]
struct AuthRateLimiter {
    failures: StdMutex<HashMap<IpAddr, VecDeque<Instant>>>,
}

impl AuthRateLimiter {
    fn is_blocked(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(attempts) = failures.get_mut(&ip) else {
            return false;
        };
        while attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) > AUTH_FAILURE_WINDOW)
        {
            attempts.pop_front();
        }
        attempts.len() >= AUTH_FAILURE_LIMIT
    }

    fn record_failure(&self, ip: IpAddr) {
        let now = Instant::now();
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let attempts = failures.entry(ip).or_default();
        while attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) > AUTH_FAILURE_WINDOW)
        {
            attempts.pop_front();
        }
        attempts.push_back(now);
    }

    fn clear(&self, ip: IpAddr) {
        self.failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&ip);
    }
}

#[derive(Clone)]
struct AuthSession {
    device: RemoteDevice,
    token: String,
}

pub(crate) fn router(
    app: AppHandle,
    paths: HostPaths,
    shutdown: watch::Receiver<bool>,
    auth_generation: watch::Receiver<u64>,
) -> Router {
    let state = RemoteHttpState {
        app,
        paths,
        rate_limiter: Arc::new(AuthRateLimiter::default()),
        shutdown,
        auth_generation,
    };

    let protected = Router::new()
        .route("/api/v1/bootstrap", get(bootstrap))
        .route("/api/v1/sessions", get(sessions))
        .route("/api/v1/history", get(history))
        .route("/api/v1/history/image", get(history_image))
        .route("/api/v1/sessions/title", post(session_title))
        .route("/api/v1/models", get(models))
        .route("/api/v1/chat/start", post(chat_start))
        .route("/api/v1/chat/state", get(chat_state))
        .route("/api/v1/chat/rpc", post(chat_rpc))
        .route("/api/v1/files/search", get(files_search))
        .route("/api/v1/events", get(events))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/auth/pair", post(pair))
        .merge(protected)
        .fallback(asset)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(45),
        ))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "pilo-remote" }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    secret: String,
    device_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    token: String,
    device: RemoteDevice,
}

async fn pair(
    State(state): State<RemoteHttpState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    Json(request): Json<PairRequest>,
) -> Response {
    if state.rate_limiter.is_blocked(address.ip()) {
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many authentication attempts",
        );
    }
    let paths = state.paths.clone();
    let result = tokio::task::spawn_blocking(move || {
        auth::exchange_pairing(&paths, &request.secret, request.device_name.as_deref())
    })
    .await;
    match result {
        Ok(Ok(Some(paired))) => {
            state.rate_limiter.clear(address.ip());
            let remote = state.app.state::<super::manager::RemoteServerManager>();
            if let Err(error) = remote.regenerate_pairing(&state.app).await {
                log::warn!(
                    target: "remote-webui",
                    "paired a device but failed to rotate the one-time pairing link: {error}"
                );
            }
            (
                StatusCode::OK,
                Json(PairResponse {
                    token: paired.token,
                    device: paired.device,
                }),
            )
                .into_response()
        }
        Ok(Ok(None)) => {
            state.rate_limiter.record_failure(address.ip());
            api_error(StatusCode::UNAUTHORIZED, "invalid or expired pairing link")
        }
        Ok(Err(error)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("pairing task failed: {error}"),
        ),
    }
}

async fn require_auth(
    State(state): State<RemoteHttpState>,
    mut request: Request,
    next: Next,
) -> Response {
    let ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    if ip.is_some_and(|ip| state.rate_limiter.is_blocked(ip)) {
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many authentication attempts",
        );
    }

    let Some(token) = token_from_headers(request.headers()) else {
        if let Some(ip) = ip {
            state.rate_limiter.record_failure(ip);
        }
        return api_error(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let paths = state.paths.clone();
    let auth_token = token.clone();
    let result = tokio::task::spawn_blocking(move || auth::authenticate(&paths, &auth_token)).await;
    match result {
        Ok(Ok(Some(device))) => {
            if let Some(ip) = ip {
                state.rate_limiter.clear(ip);
            }
            request
                .extensions_mut()
                .insert(AuthSession { device, token });
            next.run(request).await
        }
        Ok(Ok(None)) => {
            if let Some(ip) = ip {
                state.rate_limiter.record_failure(ip);
            }
            api_error(StatusCode::UNAUTHORIZED, "invalid or expired device token")
        }
        Ok(Err(error)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("authentication task failed: {error}"),
        ),
    }
}

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_owned());
    }
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find_map(|protocol| protocol.strip_prefix("pilo-token."))
        })
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    projects: Vec<Project>,
    chat_sessions: Vec<crate::runtime::chat_sessions::ChatSessionState>,
    latest_sequence: u64,
}

async fn bootstrap(State(state): State<RemoteHttpState>) -> Response {
    let projects =
        match storage::open_with_paths(&state.paths).and_then(|db| storage::list_projects(&db)) {
            Ok(projects) => projects,
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
    let runtime = state.app.state::<PiloRuntime>();
    let events = state.app.state::<RuntimeEventBus>();
    Json(BootstrapResponse {
        projects,
        chat_sessions: runtime.chat_sessions.states().await,
        latest_sequence: events.latest_sequence(),
    })
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionsQuery {
    project_id: String,
}

async fn sessions(
    State(state): State<RemoteHttpState>,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match session_index::reconcile(&state.app, &runtime.servers, &project).await {
        Ok(work) => Json(work.result.sessions).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    project_id: String,
    session_path: String,
    start_message: Option<usize>,
    message_limit: Option<usize>,
    include_message_index: Option<bool>,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
}

async fn history(
    State(state): State<RemoteHttpState>,
    Query(query): Query<HistoryQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.paths, &project)
    }) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    let limit = query.message_limit.unwrap_or(200).clamp(1, 400);
    let expected_fingerprint = match expected_session_fingerprint(
        query.expected_file_size,
        query.expected_file_mtime_ns.as_deref(),
    ) {
        Ok(value) => value,
        Err(error) => return api_error(StatusCode::BAD_REQUEST, &error),
    };
    match session_history::read_history_window_json(
        &runtime.servers,
        &runtime.session_history_cache,
        &project,
        &query.session_path,
        expected_fingerprint,
        query.start_message,
        limit,
        query.include_message_index.unwrap_or(true),
    )
    .await
    {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(bytes))
            .unwrap_or_else(|error| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("failed to build history response: {error}"),
                )
            }),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryImageQuery {
    project_id: String,
    session_path: String,
    image_id: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
}

fn expected_session_fingerprint(
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<&str>,
) -> Result<Option<(u64, u64)>, String> {
    let expected_file_mtime_ns = expected_file_mtime_ns
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("invalid expected session mtime '{value}': {error}"))
        })
        .transpose()?;
    Ok(expected_file_size.zip(expected_file_mtime_ns))
}

async fn history_image(
    State(state): State<RemoteHttpState>,
    Query(query): Query<HistoryImageQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.paths, &project)
    }) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let expected_fingerprint = match expected_session_fingerprint(
        query.expected_file_size,
        query.expected_file_mtime_ns.as_deref(),
    ) {
        Ok(value) => value,
        Err(error) => return api_error(StatusCode::BAD_REQUEST, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match session_history::read_history_image_bytes(
        &runtime.servers,
        &runtime.session_history_cache,
        &project,
        &query.session_path,
        &query.image_id,
        expected_fingerprint,
    )
    .await
    {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            )
            .body(Body::from(bytes))
            .unwrap_or_else(|error| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("failed to build history image response: {error}"),
                )
            }),
        Err(error) => api_error(StatusCode::NOT_FOUND, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionTitleRequest {
    project_id: String,
    message: String,
}

async fn session_title(
    State(state): State<RemoteHttpState>,
    Json(request): Json<SessionTitleRequest>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    match crate::runtime::commands::generate_session_title(
        &state.app,
        &runtime,
        &request.project_id,
        &request.message,
    )
    .await
    {
        Ok(title) => Json(title).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelsQuery {
    project_id: String,
}

/// Read-only model catalog used by the Remote WebUI composer. The Desktop
/// client already keeps `project_model_cache` fresh through its Pi probe
/// sessions; Remote reuses that snapshot instead of spawning its own probe.
async fn models(
    State(state): State<RemoteHttpState>,
    Query(query): Query<ModelsQuery>,
) -> Response {
    match storage::open_with_paths(&state.paths)
        .and_then(|db| storage::list_project_model_cache(&db))
    {
        Ok(caches) => {
            let cache = caches
                .into_iter()
                .find(|cache| cache.project_id == query.project_id);
            Json(cache).into_response()
        }
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStartRequest {
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: Option<bool>,
}

async fn chat_start(
    State(state): State<RemoteHttpState>,
    Json(request): Json<ChatStartRequest>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    let events = state.app.state::<RuntimeEventBus>().inner().clone();
    match chat_service::start(
        &state.paths,
        &runtime,
        events,
        ChatSessionRequest {
            project_id: request.project_id,
            session_key: request.session_key,
            session_path: request.session_path,
            no_session: request.no_session.unwrap_or(false),
            extensions: Vec::new(),
        },
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStateQuery {
    session_key: String,
}

async fn chat_state(
    State(state): State<RemoteHttpState>,
    Query(query): Query<ChatStateQuery>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    Json(runtime.chat_sessions.state(&query.session_key).await).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRpcRequest {
    session_key: String,
    command: Value,
}

async fn chat_rpc(
    State(state): State<RemoteHttpState>,
    Json(request): Json<ChatRpcRequest>,
) -> Response {
    if let Err(error) = validate_remote_rpc(&request.command) {
        return api_error(StatusCode::BAD_REQUEST, &error);
    }
    let runtime = state.app.state::<PiloRuntime>();
    match runtime
        .chat_sessions
        .send(&request.session_key, request.command)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSearchQuery {
    project_id: String,
    query: String,
}

/// Read-only file-name search used to power `@` mentions in the Mobile
/// composer. It reuses the same `fs.search` host call as Desktop; no file
/// contents are exposed.
async fn files_search(
    State(state): State<RemoteHttpState>,
    Query(query): Query<FileSearchQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match remote_fs::search(&runtime.servers, &project, &query.query).await {
        Ok(paths) => Json(paths).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

fn validate_remote_rpc(command: &Value) -> Result<(), String> {
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "chat command is missing a type".to_owned())?;
    const ALLOWED: &[&str] = &[
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "get_state",
        "get_messages",
        "get_entries",
        "get_session_stats",
        "get_commands",
        "get_available_models",
        "get_available_thinking_levels",
        "set_model",
        "cycle_model",
        "set_thinking_level",
        "set_session_name",
        "fork",
        "clone",
        "compact",
        "abort_retry",
        "clear_queue",
        "extension_ui_response",
    ];
    if !ALLOWED.contains(&command_type) {
        return Err(format!(
            "chat command '{command_type}' is not available over Remote WebUI"
        ));
    }
    if matches!(command_type, "prompt" | "steer" | "follow_up") {
        validate_remote_images(command)?;
    }
    Ok(())
}

fn validate_remote_images(command: &Value) -> Result<(), String> {
    let Some(images) = command.get("images") else {
        return Ok(());
    };
    let images = images
        .as_array()
        .ok_or_else(|| "images must be an array".to_owned())?;
    if images.len() > MAX_CHAT_IMAGES {
        return Err(format!(
            "at most {MAX_CHAT_IMAGES} images can be sent at once"
        ));
    }
    let mut total = 0_usize;
    for image in images {
        if image.get("type").and_then(Value::as_str) != Some("image") {
            return Err("Remote WebUI accepts image attachments only".to_owned());
        }
        let mime = image
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or_else(|| "image attachment is missing mimeType".to_owned())?;
        if !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            return Err(format!("unsupported image type '{mime}'"));
        }
        let data = image
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "image attachment is missing data".to_owned())?;
        let estimated_bytes = data.len().saturating_mul(3) / 4;
        if estimated_bytes > MAX_CHAT_IMAGE_BYTES {
            return Err("image attachment exceeds 10 MB".to_owned());
        }
        total = total.saturating_add(estimated_bytes);
    }
    if total > MAX_CHAT_IMAGE_TOTAL_BYTES {
        return Err("image attachments exceed 20 MB total".to_owned());
    }
    Ok(())
}

#[derive(Deserialize)]
struct EventQuery {
    after: Option<u64>,
}

async fn events(
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
                        let batch = collect_event_batch(first, &mut receiver).await;
                        if send_event_batch(&mut socket, &batch).await.is_err() {
                            break;
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

async fn collect_event_batch(
    first: SequencedRuntimeEvent,
    receiver: &mut broadcast::Receiver<SequencedRuntimeEvent>,
) -> Vec<SequencedRuntimeEvent> {
    let mut batch = vec![first];
    let deadline = tokio::time::Instant::now() + WS_BATCH_WINDOW;
    while batch.len() < WS_BATCH_MAX_EVENTS {
        match tokio::time::timeout_at(deadline, receiver.recv()).await {
            Ok(Ok(event)) => batch.push(event),
            _ => break,
        }
    }
    batch
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

fn get_project(paths: &HostPaths, project_id: &str) -> Result<Project, String> {
    storage::get_project(&storage::open_with_paths(paths)?, project_id)?
        .ok_or_else(|| format!("Project '{project_id}' was not found"))
}

async fn asset(State(state): State<RemoteHttpState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if path.is_empty() { "index.html" } else { path };
    let asset = state
        .app
        .asset_resolver()
        .get(path.to_owned())
        .or_else(|| state.app.asset_resolver().get("index.html".to_owned()));
    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cache_control = if path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime_type)
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(asset.bytes))
        .unwrap_or_else(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to build asset response: {error}"),
            )
        })
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_rpc_rejects_non_chat_commands() {
        assert!(validate_remote_rpc(&json!({"type":"prompt","message":"hello"})).is_ok());
        assert!(validate_remote_rpc(&json!({"type":"terminal_write","data":"whoami"})).is_err());
        assert!(validate_remote_rpc(&json!({"type":"fs_read_file","path":"/tmp/a"})).is_err());
    }

    #[test]
    fn remote_rpc_rejects_generic_file_attachments() {
        let command = json!({
            "type": "prompt",
            "message": "inspect this",
            "images": [{
                "type": "file",
                "mimeType": "text/plain",
                "data": "aGVsbG8="
            }]
        });
        assert!(validate_remote_rpc(&command).is_err());
    }

    #[test]
    fn websocket_token_uses_protocol_header_not_url() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            "pilo, pilo-token.secret_123".parse().unwrap(),
        );
        assert_eq!(token_from_headers(&headers).as_deref(), Some("secret_123"));
    }
}
