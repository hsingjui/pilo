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
    http::{HeaderMap, Method, StatusCode, Uri, header, request::Parts},
    middleware::{from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tower_http::timeout::TimeoutLayer;

use crate::{
    Runtime,
    connection_diagnostics::request_failure_reason,
    host_paths::HostPaths,
    storage,
    web_assets::{WebAsset, WebAssets},
};
use pilo_domain::{Project, RemoteAccessAddress, RemoteDevice};

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
const AUTH_FAILURE_MAX_IPS: usize = 4096;

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
    failures: StdMutex<AuthFailures>,
}

#[derive(Default)]
struct AuthFailures {
    by_ip: HashMap<IpAddr, [VecDeque<Instant>; 2]>,
    insertion_order: VecDeque<IpAddr>,
}

#[derive(Clone, Copy)]
enum AuthKind {
    Pairing,
    Device,
}

impl AuthRateLimiter {
    fn is_blocked(&self, kind: AuthKind, ip: IpAddr) -> bool {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(attempts) = failures.by_ip.get_mut(&ip) else {
            return false;
        };
        Self::prune_expired(&mut attempts[kind as usize], Instant::now());
        attempts[kind as usize].len() >= AUTH_FAILURE_LIMIT
    }

    fn prune_expired(attempts: &mut VecDeque<Instant>, now: Instant) {
        while attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) >= AUTH_FAILURE_WINDOW)
        {
            attempts.pop_front();
        }
    }

    fn try_record_failure(&self, kind: AuthKind, ip: IpAddr) -> bool {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !failures.by_ip.contains_key(&ip) {
            if failures.by_ip.len() == AUTH_FAILURE_MAX_IPS
                && let Some(oldest) = failures.insertion_order.pop_front()
            {
                failures.by_ip.remove(&oldest);
            }
            failures.insertion_order.push_back(ip);
        }
        let attempts = &mut failures.by_ip.entry(ip).or_default()[kind as usize];
        let now = Instant::now();
        Self::prune_expired(attempts, now);
        if attempts.len() >= AUTH_FAILURE_LIMIT {
            return false;
        }
        attempts.push_back(now);
        true
    }

    fn clear(&self, kind: AuthKind, ip: IpAddr) {
        if let Some(attempts) = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .by_ip
            .get_mut(&ip)
        {
            attempts[kind as usize].clear();
        }
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
    origins: watch::Receiver<Vec<RemoteAccessAddress>>,
) -> Router {
    let state = RemoteRouterState {
        runtime: runtime.downgrade(),
        pairing,
        rate_limiter: Arc::new(AuthRateLimiter::default()),
        shutdown: shutdown.clone(),
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
            "/api/v1/sessions/ui-state",
            post(sessions::session_ui_state),
        )
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
        .route(
            "/api/v1/cache-keep-alive/pause",
            post(model_settings::cache_keep_alive_pause),
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
        .layer(from_fn_with_state(origins, middleware::enforce_origin))
        .layer(from_fn_with_state(shutdown, middleware::cancel_on_shutdown))
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

fn asset_cache_control(path: &str) -> &'static str {
    if path == "index.html" || path == "manifest.webmanifest" {
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

async fn asset(state: RemoteHttpState, uri: Uri, method: Method, headers: HeaderMap) -> Response {
    serve_asset(state.runtime.web_assets(), uri, method, &headers)
}

fn accepts_sidecars(path: &str) -> bool {
    path == "index.html"
        || (path.split('/').any(has_content_hash_segment)
            && matches!(
                path.rsplit_once('.'),
                Some((_, "wasm" | "js" | "css" | "bin"))
            ))
}

fn compressed_asset(
    assets: &dyn WebAssets,
    path: &str,
    [br, gzip, identity, wildcard]: [Option<f32>; 4],
) -> Option<(WebAsset, &'static str)> {
    let mut encodings = [
        ("br", "br", br.or(wildcard).unwrap_or(0.0)),
        ("gzip", "gz", gzip.or(wildcard).unwrap_or(0.0)),
    ];
    if encodings[1].2 > encodings[0].2 {
        encodings.swap(0, 1);
    }
    encodings
        .into_iter()
        .find_map(|(coding, extension, quality)| {
            if quality == 0.0 || quality < identity.unwrap_or(0.0) {
                return None;
            }
            assets
                .get_precompressed(path, extension)
                .map(|asset| (asset, coding))
        })
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

fn serve_asset(
    assets: Option<&dyn WebAssets>,
    uri: Uri,
    method: Method,
    headers: &HeaderMap,
) -> Response {
    let path = uri.path().trim_start_matches('/');
    let Some(assets) = assets.filter(|_| !path.starts_with("api/")) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = if path.is_empty() { "index.html" } else { path };
    let qualities = encoding_qualities(headers);
    let (path, representation) = match asset_representation(assets, path, qualities) {
        Some(representation) => (path, representation),
        None if path != "index.html" && allows_spa_fallback(path) => (
            "index.html",
            match asset_representation(assets, "index.html", qualities) {
                Some(representation) => representation,
                None => return StatusCode::NOT_FOUND.into_response(),
            },
        ),
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let varies = accepts_sidecars(path);
    let (asset, encoding) = representation;
    let [_, _, identity, wildcard] = qualities;
    if varies && encoding.is_none() && identity.or(wildcard) == Some(0.0) {
        return (
            StatusCode::NOT_ACCEPTABLE,
            [(header::VARY, "Accept-Encoding")],
        )
            .into_response();
    }

    let mut response = Response::builder().header(header::CACHE_CONTROL, asset_cache_control(path));
    if varies {
        response = response.header(header::VARY, "Accept-Encoding");
    }
    if matches!(path, "index.html" | "manifest.webmanifest") {
        let etag = format!("\"{:x}\"", Sha256::digest(&asset.bytes));
        response = response.header(header::ETAG, &etag);
        if matches!(method, Method::GET | Method::HEAD) && matches_etag(headers, &etag) {
            return response
                .status(StatusCode::NOT_MODIFIED)
                .body(Body::empty())
                .expect("valid asset headers");
        }
    }
    if let Some(encoding) = encoding {
        response = response.header(header::CONTENT_ENCODING, encoding);
    }
    response
        .header(header::CONTENT_TYPE, asset.mime_type)
        .body(Body::from(asset.bytes))
        .unwrap_or_else(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to build asset response: {error}"),
            )
        })
}

fn asset_representation(
    assets: &dyn WebAssets,
    path: &str,
    qualities: [Option<f32>; 4],
) -> Option<(WebAsset, Option<&'static str>)> {
    if accepts_sidecars(path)
        && let Some((asset, coding)) = compressed_asset(assets, path, qualities)
    {
        return Some((asset, Some(coding)));
    }
    assets.get(path).map(|asset| (asset, None))
}

fn matches_etag(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .flat_map(|value| value.as_bytes().split(|&byte| byte == b','))
        .map(|tag| tag.trim_ascii())
        .any(|tag| tag == b"*" || tag.strip_prefix(b"W/").unwrap_or(tag) == etag.as_bytes())
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

    #[test]
    fn auth_failure_limit_keeps_ips_independent() {
        let limiter = AuthRateLimiter::default();
        let first = "192.168.1.1".parse().unwrap();
        let second = "192.168.1.2".parse().unwrap();
        for _ in 0..AUTH_FAILURE_LIMIT {
            assert!(limiter.try_record_failure(AuthKind::Device, first));
        }
        assert!(limiter.is_blocked(AuthKind::Device, first));
        assert!(!limiter.is_blocked(AuthKind::Device, second));
        assert!(!limiter.is_blocked(AuthKind::Pairing, first));
        limiter.clear(AuthKind::Device, first);
        assert!(!limiter.is_blocked(AuthKind::Device, first));
    }

    #[test]
    fn concurrent_auth_failures_cannot_exceed_the_budget() {
        let limiter = AuthRateLimiter::default();
        let barrier = std::sync::Barrier::new(16);
        let ip = "192.168.1.1".parse().unwrap();
        let admitted = std::thread::scope(|scope| {
            (0..16)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        limiter.try_record_failure(AuthKind::Device, ip)
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|admitted| *admitted)
                .count()
        });
        assert_eq!(admitted, AUTH_FAILURE_LIMIT);
    }

    #[test]
    fn auth_failure_table_caps_distinct_ips_and_evicts_oldest() {
        let limiter = AuthRateLimiter::default();
        for index in 0..=AUTH_FAILURE_MAX_IPS {
            let ip = IpAddr::V4(std::net::Ipv4Addr::from(index as u32));
            assert!(limiter.try_record_failure(AuthKind::Device, ip));
            assert!(limiter.try_record_failure(AuthKind::Pairing, ip));
        }
        let failures = limiter.failures.lock().unwrap();
        assert_eq!(failures.by_ip.len(), AUTH_FAILURE_MAX_IPS);
        assert_eq!(failures.insertion_order.len(), AUTH_FAILURE_MAX_IPS);
        assert!(!failures.by_ip.contains_key(&"0.0.0.0".parse().unwrap()));
        assert!(failures.by_ip.contains_key(&"0.0.0.1".parse().unwrap()));
    }

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

        fn get_precompressed(&self, path: &str, extension: &str) -> Option<WebAsset> {
            let mime_type = match path {
                "index.html" => "text/html",
                "nsh.04f05f7ecb.wasm" => "application/wasm",
                _ => return None,
            };
            match extension {
                "br" | "gz" => Some(WebAsset {
                    bytes: extension.as_bytes().to_vec(),
                    mime_type: mime_type.into(),
                }),
                _ => None,
            }
        }
    }

    #[tokio::test]
    async fn serves_in_memory_assets_and_preserves_fallback_and_missing_routes() {
        for path in ["/", "/pair", "/pair/complete", "/chat/session"] {
            let response = serve_asset(
                Some(&MemoryAssets),
                Uri::from_static(path),
                Method::GET,
                &HeaderMap::new(),
            );
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
            let response = serve_asset(
                Some(&MemoryAssets),
                Uri::from_static(path),
                Method::GET,
                &HeaderMap::new(),
            );
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
            Method::GET,
            &HeaderMap::new(),
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
                serve_asset(
                    Some(&MemoryAssets),
                    Uri::from_static(path),
                    Method::GET,
                    &HeaderMap::new()
                )
                .status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        assert_eq!(
            serve_asset(None, Uri::from_static("/"), Method::GET, &HeaderMap::new()).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn negotiates_document_compression_and_validates_cached_representations() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, "gzip, br".parse().unwrap());
        let get = |path: &'static str, headers: &HeaderMap| {
            serve_asset(
                Some(&MemoryAssets),
                Uri::from_static(path),
                Method::GET,
                headers,
            )
        };
        let root = get("/", &headers);
        assert_eq!(root.status(), StatusCode::OK);
        assert_eq!(root.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(root.headers()[header::CONTENT_TYPE], "text/html");
        assert_eq!(root.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(root.headers()[header::VARY], "Accept-Encoding");
        let tag = root.headers()[header::ETAG].clone();
        headers.insert(
            header::IF_NONE_MATCH,
            format!("\"other\", W/{}", tag.to_str().unwrap())
                .parse()
                .unwrap(),
        );
        for path in ["/", "/index.html", "/pair"] {
            let cached = get(path, &headers);
            assert_eq!(cached.status(), StatusCode::NOT_MODIFIED, "{path}");
            assert_eq!(cached.headers()[header::ETAG], tag);
            assert_eq!(cached.headers()[header::VARY], "Accept-Encoding");
            assert_eq!(cached.headers()[header::CACHE_CONTROL], "no-cache");
        }

        headers.insert(header::ACCEPT_ENCODING, "br;q=0.5, gzip".parse().unwrap());
        let gzip = get("/", &headers);
        assert_eq!(gzip.status(), StatusCode::OK);
        assert_eq!(gzip.headers()[header::CONTENT_ENCODING], "gzip");
        assert_ne!(gzip.headers()[header::ETAG], tag);
        headers.remove(header::ACCEPT_ENCODING);
        let raw = get("/", &headers);
        assert_eq!(raw.status(), StatusCode::OK);
        assert!(!raw.headers().contains_key(header::CONTENT_ENCODING));
        assert_ne!(raw.headers()[header::ETAG], tag);

        headers.insert(header::ACCEPT_ENCODING, "br, identity;q=0".parse().unwrap());
        let wasm = get("/nsh.04f05f7ecb.wasm", &headers);
        assert_eq!(wasm.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(
            wasm.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            get("/app.50797f7b13.js", &headers).status(),
            StatusCode::NOT_ACCEPTABLE
        );
        assert_eq!(
            get("/app.00000000.js", &headers).status(),
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
        assert_eq!(asset_cache_control("index.html"), "no-cache");
        assert_eq!(asset_cache_control("sessions/abc"), "no-cache");
        assert_eq!(asset_cache_control("manifest.webmanifest"), "no-cache");
        assert_eq!(asset_cache_control("pilo-192.png"), "no-cache");
        assert_eq!(
            asset_cache_control("app.50797f7b13.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("nsh.04f05f7ecb.wasm"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("assets/fonts/inter-latin-400-normal.8909904ab6.woff2",),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("browser.b998e17dc5/runtime.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("facades/nsh.7433008113.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            asset_cache_control("icons/192.1b09b59f5c.png"),
            "public, max-age=31536000, immutable"
        );
    }
}
