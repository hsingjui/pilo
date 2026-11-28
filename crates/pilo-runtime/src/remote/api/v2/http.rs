use std::collections::HashMap;

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

use crate::{
    events::LIVE_IMAGE_PREFIX,
    host_api::{self, BinaryOutput, ErrorCode, HostApiError},
};

use super::super::HostRequest;

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

pub(in crate::remote::api) async fn call(
    host: HostRequest,
    Path(method): Path<String>,
    body: Bytes,
) -> Response {
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

pub(in crate::remote::api) async fn upload(
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

pub(in crate::remote::api) async fn blob(
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
