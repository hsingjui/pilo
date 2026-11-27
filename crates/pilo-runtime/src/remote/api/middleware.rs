use std::{
    net::{IpAddr, SocketAddr},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

use axum::{
    Json,
    extract::{ConnectInfo, Extension, MatchedPath, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::{
    host_api::Principal,
    remote::{access, auth, pairing::PairingError},
};
use pilo_domain::{RemoteAccessAddress, RemoteDevice};

use super::{ApiFailureDiagnostic, AuthKind, AuthSession, RemoteHttpState, api_error};

pub(super) async fn cancel_on_shutdown(
    State(mut shutdown): State<watch::Receiver<bool>>,
    request: Request,
    next: Next,
) -> Response {
    // Cancellation drops the gateway request; operations already dispatched to the runtime
    // may complete and are not rolled back.
    tokio::select! {
        biased;
        _ = shutdown.wait_for(|stopped| *stopped) => {
            api_error(StatusCode::SERVICE_UNAVAILABLE, "remote connections disabled")
        }
        response = next.run(request) => response,
    }
}

pub(super) async fn enforce_origin(
    State(addresses): State<watch::Receiver<Vec<RemoteAccessAddress>>>,
    request: Request,
    next: Next,
) -> Response {
    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    if let Some(origin) = origins.next()
        && (origins.next().is_some()
            || normalized_origin(origin).is_none_or(|origin| {
                !addresses
                    .borrow()
                    .iter()
                    .any(|address| origin == address.base_url)
            }))
    {
        return api_error(
            StatusCode::FORBIDDEN,
            "remote request origin is not configured",
        );
    }
    next.run(request).await
}

fn normalized_origin(origin: &axum::http::HeaderValue) -> Option<String> {
    let origin = origin.to_str().ok()?;
    let (_, authority) = origin.split_once("://")?;
    if authority.contains(['/', '\\', '?', '#', '@', ','])
        || origin.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return None;
    }
    access::normalize_base_url(origin).ok()
}

pub(super) async fn log_request_failure(request: Request, next: Next) -> Response {
    static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
    let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    // Only declared route templates and known HTTP verbs, never URI/query/header data.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".to_owned());
    let method = match request.method().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    };
    let response = next.run(request).await;
    let status = response.status();
    let diagnostic = response.extensions().get::<ApiFailureDiagnostic>();
    if status.is_server_error()
        || status == StatusCode::REQUEST_TIMEOUT
        || (status == StatusCode::BAD_REQUEST && diagnostic.is_some())
    {
        let reason = diagnostic.map_or_else(
            || {
                Some(if status == StatusCode::REQUEST_TIMEOUT {
                    "timeout"
                } else {
                    "http_server_error"
                })
            },
            |diagnostic| diagnostic.reason,
        );
        if let Some(reason) = reason {
            let level = if status.is_server_error()
                || status == StatusCode::REQUEST_TIMEOUT
                || !matches!(reason, "unclassified" | "invalid_request")
            {
                log::Level::Warn
            } else {
                log::Level::Info
            };
            log::log!(target: "remote-http", level, "request end pid={} httpRequestId={request_id} method={method} route={route:?} status={} elapsedMs={} reason={reason}", std::process::id(), status.as_u16(), started.elapsed().as_millis());
        }
    }
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairRequest {
    secret: String,
    #[serde(default)]
    address_id: String,
    #[serde(default)]
    request_id: String,
    device_name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct PairingInfoRequest {
    secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairResponse {
    token: String,
    device: RemoteDevice,
}

pub(super) async fn pairing_info(
    state: RemoteHttpState,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    Json(request): Json<PairingInfoRequest>,
) -> Response {
    if state
        .rate_limiter
        .is_blocked(AuthKind::Pairing, address.ip())
    {
        return auth_rate_limited();
    }
    let pairing = state.pairing.clone();
    let result = tokio::task::spawn_blocking(move || pairing.describe(&request.secret))
        .await
        .unwrap_or_else(|_| Err(PairingError::Internal("pairing task failed".to_owned())));
    pairing_response(&state, address.ip(), result)
}

pub(super) async fn pair(
    state: RemoteHttpState,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    Json(request): Json<PairRequest>,
) -> Response {
    if state
        .rate_limiter
        .is_blocked(AuthKind::Pairing, address.ip())
    {
        return auth_rate_limited();
    }
    let paths = state.runtime.paths.clone();
    let pairing = state.pairing.clone();
    let pair_ip = address.ip().to_string();
    let result = tokio::task::spawn_blocking(move || {
        pairing
            .exchange(
                &paths,
                &request.secret,
                &request.address_id,
                &request.request_id,
                request.device_name.as_deref(),
                &pair_ip,
            )
            .map(|paired| PairResponse {
                token: paired.token,
                device: paired.device,
            })
    })
    .await
    .unwrap_or_else(|_| Err(PairingError::Internal("pairing task failed".to_owned())));
    pairing_response(&state, address.ip(), result)
}

pub(super) async fn pairing_no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

fn auth_rate_limited() -> Response {
    api_error(
        StatusCode::TOO_MANY_REQUESTS,
        "too many authentication attempts",
    )
}

fn pairing_response<T: Serialize>(
    state: &RemoteHttpState,
    ip: IpAddr,
    result: Result<T, PairingError>,
) -> Response {
    match result {
        Ok(value) => {
            state.rate_limiter.clear(AuthKind::Pairing, ip);
            Json(value).into_response()
        }
        Err(PairingError::Unauthorized) => {
            if state.rate_limiter.try_record_failure(AuthKind::Pairing, ip) {
                api_error(StatusCode::UNAUTHORIZED, "invalid or expired pairing link")
            } else {
                auth_rate_limited()
            }
        }
        Err(PairingError::InvalidRequest(message)) => api_error(StatusCode::BAD_REQUEST, message),
        Err(PairingError::AlreadyUsed) => {
            api_error(StatusCode::CONFLICT, "pairing address already used")
        }
        Err(PairingError::Internal(message)) => {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, &message)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceAuthResponse {
    expires_at_ms: u64,
}

/// 当前设备的授权到期时间，供 WebUI 提示即将过期。
pub(super) async fn device_auth(Extension(session): Extension<AuthSession>) -> Response {
    Json(DeviceAuthResponse {
        expires_at_ms: session.device.expires_at_ms,
    })
    .into_response()
}

/// 把当前设备授权重置为完整 TTL；token 不变，已建立的连接不受影响。
pub(super) async fn device_renew(
    state: RemoteHttpState,
    Extension(session): Extension<AuthSession>,
) -> Response {
    let paths = state.runtime.paths.clone();
    let device_id = session.device.id;
    match tokio::task::spawn_blocking(move || auth::renew_device(&paths, &device_id)).await {
        Ok(Ok(Some(expires_at_ms))) => Json(DeviceAuthResponse { expires_at_ms }).into_response(),
        Ok(Ok(None)) => api_error(StatusCode::UNAUTHORIZED, "invalid or expired device token"),
        Ok(Err(error)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("device renew task failed: {error}"),
        ),
    }
}

pub(super) async fn require_auth(
    state: RemoteHttpState,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let ip = address.ip();
    let Some(token) = token_from_headers(request.headers()) else {
        return api_error(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let paths = state.runtime.paths.clone();
    let auth_token = token.clone();
    let auth_generation = *state.auth_generation.borrow();
    let result = tokio::task::spawn_blocking(move || {
        auth::authenticate_cached(&paths, &auth_token, auth_generation)
    })
    .await;
    match result {
        Ok(Ok(Some(device))) => {
            request.extensions_mut().insert(Principal::Device {
                id: device.id.clone(),
                scopes: device.scopes,
            });
            request
                .extensions_mut()
                .insert(AuthSession { device, token });
            next.run(request).await
        }
        Ok(Ok(None)) => {
            if state.rate_limiter.try_record_failure(AuthKind::Device, ip) {
                api_error(StatusCode::UNAUTHORIZED, "invalid or expired device token")
            } else {
                auth_rate_limited()
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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
