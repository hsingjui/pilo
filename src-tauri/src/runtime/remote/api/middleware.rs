use std::net::SocketAddr;

use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::{
    domain::RemoteDevice,
    runtime::remote::{auth, manager::RemoteServerManager},
};

use super::{AuthSession, RemoteHttpState, api_error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairRequest {
    secret: String,
    device_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairResponse {
    token: String,
    device: RemoteDevice,
}

pub(super) async fn pair(
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
    let pair_ip = address.ip().to_string();
    let result = tokio::task::spawn_blocking(move || {
        auth::exchange_pairing(
            &paths,
            &request.secret,
            request.device_name.as_deref(),
            &pair_ip,
        )
    })
    .await;
    match result {
        Ok(Ok(Some(paired))) => {
            state.rate_limiter.clear(address.ip());
            let remote = state.app.state::<RemoteServerManager>();
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

pub(super) async fn require_auth(
    State(state): State<RemoteHttpState>,
    mut request: Request,
    next: Next,
) -> Response {
    // Device tokens are 32 random bytes (SHA-256 indexed), so there is no
    // brute-force surface worth locking an IP out for. Applying the pairing
    // rate limiter here masked the 401 that tells a WebUI client its stale
    // token is dead, turning 401s into an unrecoverable 429 lockout.
    let Some(token) = token_from_headers(request.headers()) else {
        return api_error(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let paths = state.paths.clone();
    let auth_token = token.clone();
    let result = tokio::task::spawn_blocking(move || auth::authenticate(&paths, &auth_token)).await;
    match result {
        Ok(Ok(Some(device))) => {
            request
                .extensions_mut()
                .insert(AuthSession { device, token });
            next.run(request).await
        }
        Ok(Ok(None)) => api_error(StatusCode::UNAUTHORIZED, "invalid or expired device token"),
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
