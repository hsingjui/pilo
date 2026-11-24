use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, FromRequestParts},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header, request::Parts},
    middleware::{from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio::sync::watch;
use tower_http::timeout::TimeoutLayer;

use crate::{
    Runtime,
    connection_diagnostics::request_failure_reason,
    host_paths::HostPaths,
    storage,
    web_assets::{WebAsset, WebAssets},
};
use pilo_domain::{Project, RemoteDevice};

use super::pairing::PairingSession;

mod chat;
mod host;
mod middleware;
mod model_settings;
mod sessions;
mod validation;
mod ws;

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
const AUTH_FAILURE_LIMIT: usize = 5;

#[derive(Clone)]
pub(crate) struct HttpState<R> {
    runtime: R,
    pairing: Arc<PairingSession>,
    rate_limiter: Arc<AuthRateLimiter>,
    shutdown: watch::Receiver<bool>,
    auth_generation: watch::Receiver<u64>,
}

type RemoteHttpState = HttpState<Runtime>;
type RemoteRouterState = HttpState<crate::handle::WeakRuntime>;

impl FromRequestParts<RemoteRouterState> for RemoteHttpState {
    type Rejection = Response;

    async fn from_request_parts(
        _parts: &mut Parts,
        state: &RemoteRouterState,
    ) -> Result<Self, Self::Rejection> {
        let runtime = state
            .runtime
            .upgrade()
            .map_err(|error| api_error(StatusCode::SERVICE_UNAVAILABLE, &error))?;
        Ok(Self {
            runtime,
            pairing: state.pairing.clone(),
            rate_limiter: state.rate_limiter.clone(),
            shutdown: state.shutdown.clone(),
            auth_generation: state.auth_generation.clone(),
        })
    }
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
    runtime: Runtime,
    pairing: Arc<PairingSession>,
    shutdown: watch::Receiver<bool>,
    auth_generation: watch::Receiver<u64>,
) -> Router {
    let state = RemoteRouterState {
        runtime: runtime.downgrade(),
        pairing,
        rate_limiter: Arc::new(AuthRateLimiter::default()),
        shutdown,
        auth_generation,
    };

    let protected = Router::new()
        .route("/api/v1/bootstrap", get(host::bootstrap))
        .route("/api/v1/auth/device", get(middleware::device_auth))
        .route("/api/v1/auth/device/renew", post(middleware::device_renew))
        .route(
            "/api/v1/connections/local-pi-resources",
            post(host::local_pi_resources_set),
        )
        .route(
            "/api/v1/preferences",
            get(host::preferences_get).post(host::preferences_patch),
        )
        .route(
            "/api/v1/theme",
            get(host::theme_settings).post(host::theme_settings_set),
        )
        .route("/api/v1/sessions", get(sessions::sessions))
        .route(
            "/api/v1/sessions/read-state",
            get(sessions::session_read_states).post(sessions::session_mark_read),
        )
        .route("/api/v1/sessions/search", get(sessions::sessions_search))
        .route(
            "/api/v1/sessions/external-activity",
            get(sessions::sessions_external_activity),
        )
        .route("/api/v1/history", get(sessions::history))
        .route("/api/v1/history/image", get(sessions::history_image))
        .route("/api/v1/sessions/title", post(sessions::session_title))
        .route("/api/v1/sessions/delete", post(sessions::session_delete))
        .route(
            "/api/v1/models",
            get(model_settings::models).post(model_settings::models_set),
        )
        .route(
            "/api/v1/connections/models",
            get(model_settings::connection_models),
        )
        .route(
            "/api/v1/models/scope",
            get(model_settings::model_scope_get).post(model_settings::model_scope_set),
        )
        .route(
            "/api/v1/next-prompt/settings",
            get(model_settings::next_prompt_settings_get)
                .post(model_settings::next_prompt_settings_set),
        )
        .route(
            "/api/v1/next-prompt/request",
            post(model_settings::next_prompt_request),
        )
        .route(
            "/api/v1/prompt-enhancement/settings",
            get(model_settings::prompt_enhancement_settings_get)
                .post(model_settings::prompt_enhancement_settings_set),
        )
        .route(
            "/api/v1/prompt-enhancement/enhance",
            post(model_settings::prompt_enhance),
        )
        .route(
            "/api/v1/cache-keep-alive/settings",
            get(model_settings::cache_keep_alive_settings_list)
                .post(model_settings::cache_keep_alive_settings_set),
        )
        .route("/api/v1/chat/start", post(chat::chat_start))
        .route("/api/v1/chat/stop", post(chat::chat_stop))
        .route("/api/v1/chat/state", get(chat::chat_state))
        .route("/api/v1/chat/transcript", get(chat::chat_transcript))
        .route("/api/v1/chat/rpc", post(chat::chat_rpc))
        .route("/api/v1/chat/mcp-approve", post(chat::chat_mcp_approve))
        .route("/api/v1/files/search", get(chat::files_search))
        .route("/api/v1/files/image", get(chat::project_image))
        .route(
            "/api/v1/chat/files",
            post(chat::chat_file_upload)
                .delete(chat::chat_file_remove)
                .layer(DefaultBodyLimit::max(crate::remote_fs::MAX_CHAT_FILE_BYTES)),
        )
        .route("/api/v1/events", get(ws::events))
        .route_layer(from_fn_with_state(state.clone(), middleware::require_auth));

    let pairing = Router::new()
        .route("/api/v1/auth/pairing", post(middleware::pairing_info))
        .route("/api/v1/auth/pair", post(middleware::pair))
        .route_layer(from_fn(middleware::pairing_no_store));

    Router::new()
        .route("/api/v1/health", get(health))
        .merge(pairing)
        .merge(protected)
        .fallback(asset)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(45),
        ))
        .layer(from_fn(middleware::log_request_failure))
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
    if path.starts_with("api/")
        || path.starts_with("assets/")
        || path.starts_with("icons/")
        || path.starts_with("facades/")
        || path.starts_with("browser.")
    {
        return false;
    }
    !path
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('.'))
}

fn has_content_hash_segment(segment: &str) -> bool {
    // Matches nsh's fingerprinted filenames (`app.50797f7b13.js`, `browser.b998e17dc5`, `192.1b09b59f5c.png`).
    segment
        .split('.')
        .any(|part| part.len() >= 8 && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn asset_cache_control(path: &str, spa_fallback: bool) -> &'static str {
    if spa_fallback || path == "index.html" || path == "manifest.webmanifest" {
        return "no-cache";
    }
    if path.starts_with("assets/")
        || path.starts_with("facades/")
        || path.starts_with("icons/")
        || path.starts_with("browser.")
        || path.split('/').any(has_content_hash_segment)
    {
        return "public, max-age=31536000, immutable";
    }
    "no-cache"
}

async fn asset(state: RemoteHttpState, uri: Uri, headers: HeaderMap) -> Response {
    let assets = state.runtime.web_assets();
    let path = uri.path().trim_start_matches('/');
    let name = path.rsplit('/').next().unwrap_or_default();
    // A fingerprint can be in the filename or a parent directory.
    if path.starts_with("api/")
        || !path.split('/').any(has_content_hash_segment)
        || !matches!(
            name.rsplit_once('.'),
            Some((_, "wasm" | "js" | "css" | "bin"))
        )
    {
        return serve_asset(assets, uri);
    }

    let [br, gzip, identity, wildcard] = encoding_qualities(&headers);
    let mut encodings = [
        ("br", "br", br.or(wildcard).unwrap_or(0.0)),
        ("gzip", "gz", gzip.or(wildcard).unwrap_or(0.0)),
    ];
    if encodings[1].2 > encodings[0].2 {
        encodings.swap(0, 1);
    }
    let compressed = assets.and_then(|assets| {
        encodings
            .into_iter()
            .find_map(|(coding, extension, quality)| {
                if quality == 0.0 || quality < identity.unwrap_or(0.0) {
                    return None;
                }
                let asset = assets.get_precompressed(path, extension)?;
                let mut response = asset_response(asset, asset_cache_control(path, false));
                response
                    .headers_mut()
                    .insert(header::CONTENT_ENCODING, HeaderValue::from_static(coding));
                Some(response)
            })
    });
    let mut response = compressed.unwrap_or_else(|| {
        let response = serve_asset(assets, uri);
        if response.status().is_success() && identity.or(wildcard) == Some(0.0) {
            return StatusCode::NOT_ACCEPTABLE.into_response();
        }
        response
    });
    if response.status().is_success() || response.status() == StatusCode::NOT_ACCEPTABLE {
        response
            .headers_mut()
            .append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }
    response
}

fn encoding_qualities(headers: &HeaderMap) -> [Option<f32>; 4] {
    let mut qualities = [None; 4];
    for entry in headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
    {
        let (coding, parameter) = entry
            .split_once(';')
            .map_or((entry, None), |(coding, param)| (coding, Some(param)));
        let Some(index) = ["br", "gzip", "identity", "*"]
            .iter()
            .position(|name| coding.trim().eq_ignore_ascii_case(name))
        else {
            continue;
        };
        qualities[index] = Some(parameter.map_or(1.0, |param| {
            param
                .split_once('=')
                .filter(|(key, _)| key.trim().eq_ignore_ascii_case("q"))
                .and_then(|(_, value)| value.trim().parse::<f32>().ok())
                .filter(|quality| (0.0..=1.0).contains(quality))
                .unwrap_or(0.0)
        }));
    }
    qualities
}

fn serve_asset(assets: Option<&dyn WebAssets>, uri: Uri) -> Response {
    let requested_path = uri.path().trim_start_matches('/');
    if requested_path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if requested_path.is_empty() {
        "index.html"
    } else {
        requested_path
    };
    let mut spa_fallback = false;
    let asset = assets.and_then(|assets| assets.get(path)).or_else(|| {
        if !allows_spa_fallback(path) {
            return None;
        }
        spa_fallback = true;
        assets.and_then(|assets| assets.get("index.html"))
    });
    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };
    asset_response(asset, asset_cache_control(path, spa_fallback))
}

fn asset_response(asset: WebAsset, cache_control: &'static str) -> Response {
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

#[derive(Clone, Copy)]
struct ApiFailureDiagnostic {
    reason: Option<&'static str>,
}

fn api_error(status: StatusCode, message: &str) -> Response {
    let mut response = (status, Json(json!({ "error": message }))).into_response();
    response.extensions_mut().insert(ApiFailureDiagnostic {
        reason: request_failure_reason("http", message),
    });
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_state_upgrades_only_while_runtime_is_alive() {
        let runtime = Runtime::new(HostPaths::for_test(std::path::PathBuf::new()));
        let state = RemoteRouterState {
            runtime: runtime.downgrade(),
            pairing: Arc::new(PairingSession::default()),
            rate_limiter: Arc::new(AuthRateLimiter::default()),
            shutdown: watch::channel(false).1,
            auth_generation: watch::channel(0).1,
        };
        let (mut parts, ()) = axum::http::Request::new(()).into_parts();
        let request = RemoteHttpState::from_request_parts(&mut parts, &state)
            .await
            .unwrap();
        drop(request);
        drop(runtime);
        let response = RemoteHttpState::from_request_parts(&mut parts, &state)
            .await
            .err()
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    struct MemoryAssets;

    impl crate::web_assets::WebAssets for MemoryAssets {
        fn get(&self, path: &str) -> Option<crate::web_assets::WebAsset> {
            match path {
                "index.html" => Some(crate::web_assets::WebAsset {
                    bytes: b"<html>nsh webui</html>".to_vec(),
                    mime_type: "text/html".into(),
                }),
                "manifest.webmanifest" => Some(crate::web_assets::WebAsset {
                    bytes: b"{}".to_vec(),
                    mime_type: "application/manifest+json".into(),
                }),
                "app.50797f7b13.js" => Some(crate::web_assets::WebAsset {
                    bytes: b"console.log('nsh');".to_vec(),
                    mime_type: "application/javascript".into(),
                }),
                "nsh.04f05f7ecb.wasm" => Some(crate::web_assets::WebAsset {
                    bytes: b"wasm".to_vec(),
                    mime_type: "application/wasm".into(),
                }),
                "browser.b998e17dc5/runtime.js" => Some(crate::web_assets::WebAsset {
                    bytes: b"export {};".to_vec(),
                    mime_type: "application/javascript".into(),
                }),
                "icons/192.1b09b59f5c.png" => Some(crate::web_assets::WebAsset {
                    bytes: b"png".to_vec(),
                    mime_type: "image/png".into(),
                }),
                _ => None,
            }
        }
    }

    #[tokio::test]
    async fn serves_in_memory_assets_and_preserves_fallback_and_missing_routes() {
        for path in ["/", "/pair", "/pair/complete", "/chat/session"] {
            let response = serve_asset(Some(&MemoryAssets), Uri::from_static(path));
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert_eq!(
                axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap()
                    .as_ref(),
                b"<html>nsh webui</html>"
            );
        }

        for path in [
            "/app.50797f7b13.js",
            "/nsh.04f05f7ecb.wasm",
            "/browser.b998e17dc5/runtime.js",
            "/icons/192.1b09b59f5c.png",
        ] {
            let response = serve_asset(Some(&MemoryAssets), Uri::from_static(path));
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable",
                "{path}"
            );
        }

        let manifest = serve_asset(
            Some(&MemoryAssets),
            Uri::from_static("/manifest.webmanifest"),
        );
        assert_eq!(manifest.status(), StatusCode::OK);
        assert_eq!(manifest.headers()[header::CACHE_CONTROL], "no-cache");

        for path in [
            "/api/missing",
            "/assets/missing.js",
            "/icons/missing.png",
            "/facades/missing.js",
            "/browser.b998e17dc5/missing.js",
            "/missing.js",
        ] {
            assert_eq!(
                serve_asset(Some(&MemoryAssets), Uri::from_static(path)).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        assert_eq!(
            serve_asset(None, Uri::from_static("/")).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn spa_fallback_is_only_used_for_client_routes() {
        assert!(allows_spa_fallback("pair"));
        assert!(allows_spa_fallback("pair/complete"));
        assert!(allows_spa_fallback("sessions/abc"));
        assert!(!allows_spa_fallback("assets/missing.js"));
        assert!(!allows_spa_fallback("icons/missing.png"));
        assert!(!allows_spa_fallback("facades/missing.js"));
        assert!(!allows_spa_fallback("browser.b998e17dc5/runtime.js"));
        assert!(!allows_spa_fallback("manifest.webmanifest"));
        assert!(!allows_spa_fallback("api/v1/missing"));
    }

    #[test]
    fn only_fingerprinted_assets_are_immutable() {
        assert_eq!(asset_cache_control("index.html", false), "no-cache");
        assert_eq!(asset_cache_control("sessions/abc", true), "no-cache");
        assert_eq!(
            asset_cache_control("manifest.webmanifest", false),
            "no-cache"
        );
        assert_eq!(asset_cache_control("pilo-192.png", false), "no-cache");
        assert_eq!(
            asset_cache_control("app.50797f7b13.js", false),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("nsh.04f05f7ecb.wasm", false),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control(
                "assets/fonts/inter-latin-400-normal.8909904ab6.woff2",
                false
            ),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("browser.b998e17dc5/runtime.js", false),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("facades/nsh.7433008113.js", false),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("icons/192.1b09b59f5c.png", false),
            "public, max-age=31536000, immutable"
        );
    }
}
