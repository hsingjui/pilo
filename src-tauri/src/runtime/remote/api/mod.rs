use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{StatusCode, Uri, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::watch;
use tower_http::timeout::TimeoutLayer;

use crate::{
    domain::{Project, RemoteDevice},
    runtime::{host_paths::HostPaths, storage},
};

mod handlers;
mod middleware;
mod validation;
mod ws;

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
const AUTH_FAILURE_LIMIT: usize = 5;

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
        .route("/api/v1/bootstrap", get(handlers::bootstrap))
        .route("/api/v1/sessions", get(handlers::sessions))
        .route("/api/v1/sessions/search", get(handlers::sessions_search))
        .route(
            "/api/v1/sessions/external-activity",
            get(handlers::sessions_external_activity),
        )
        .route("/api/v1/history", get(handlers::history))
        .route("/api/v1/history/image", get(handlers::history_image))
        .route("/api/v1/sessions/title", post(handlers::session_title))
        .route("/api/v1/sessions/delete", post(handlers::session_delete))
        .route("/api/v1/models", get(handlers::models))
        .route("/api/v1/chat/start", post(handlers::chat_start))
        .route("/api/v1/chat/stop", post(handlers::chat_stop))
        .route("/api/v1/chat/state", get(handlers::chat_state))
        .route("/api/v1/chat/rpc", post(handlers::chat_rpc))
        .route("/api/v1/chat/mcp-approve", post(handlers::chat_mcp_approve))
        .route("/api/v1/files/search", get(handlers::files_search))
        .route("/api/v1/events", get(ws::events))
        .route_layer(from_fn_with_state(state.clone(), middleware::require_auth));

    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/auth/pair", post(middleware::pair))
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

fn get_project(paths: &HostPaths, project_id: &str) -> Result<Project, String> {
    storage::get_project(&storage::open_with_paths(paths)?, project_id)?
        .ok_or_else(|| format!("Project '{project_id}' was not found"))
}

fn allows_spa_fallback(path: &str) -> bool {
    if path.starts_with("api/") || path.starts_with("assets/") {
        return false;
    }
    !path
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('.'))
}

fn asset_cache_control(path: &str, spa_fallback: bool) -> &'static str {
    if spa_fallback || path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    }
}

async fn asset(State(state): State<RemoteHttpState>, uri: Uri) -> Response {
    let requested_path = uri.path().trim_start_matches('/');
    if requested_path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if requested_path.is_empty() {
        "index.html"
    } else {
        requested_path
    };
    let resolver = state.app.asset_resolver();
    let mut spa_fallback = false;
    let asset = resolver.get(path.to_owned()).or_else(|| {
        if !allows_spa_fallback(path) {
            return None;
        }
        spa_fallback = true;
        resolver.get("index.html".to_owned())
    });
    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime_type)
        .header(
            header::CACHE_CONTROL,
            asset_cache_control(path, spa_fallback),
        )
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
    use super::{allows_spa_fallback, asset_cache_control};

    #[test]
    fn spa_fallback_is_only_used_for_client_routes() {
        assert!(allows_spa_fallback("sessions/abc"));
        assert!(!allows_spa_fallback("assets/missing.js"));
        assert!(!allows_spa_fallback("manifest.webmanifest"));
        assert!(!allows_spa_fallback("api/v1/missing"));
    }

    #[test]
    fn fallback_index_is_never_immutable() {
        assert_eq!(asset_cache_control("index.html", false), "no-cache");
        assert_eq!(asset_cache_control("sessions/abc", true), "no-cache");
        assert_eq!(
            asset_cache_control("assets/app-123.js", false),
            "public, max-age=31536000, immutable"
        );
    }
}
