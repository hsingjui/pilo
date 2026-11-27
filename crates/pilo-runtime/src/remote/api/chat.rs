use axum::{
    Json,
    body::{Body, Bytes},
    extract::Query,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::host_api::{BinaryOutput, HostApiError};

use super::{HostRequest, api_error, host_error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatStartRequest {
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: Option<bool>,
    #[serde(default)]
    builtin_extensions: Vec<pilo_protocol::BuiltinExtension>,
}

pub(super) async fn chat_start(
    host: HostRequest,
    Json(request): Json<ChatStartRequest>,
) -> Response {
    host.json(
        "chat.start",
        json!({"projectId": request.project_id, "sessionKey": request.session_key,
            "sessionPath": request.session_path, "noSession": request.no_session,
            "builtinExtensions": request.builtin_extensions,}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatStateQuery {
    session_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatStopRequest {
    session_key: String,
    reason: Option<String>,
}

pub(super) async fn chat_stop(host: HostRequest, Json(request): Json<ChatStopRequest>) -> Response {
    host.no_content(
        "chat.stop",
        json!({"sessionKey": request.session_key, "reason": request.reason}),
    )
    .await
}

pub(super) async fn chat_state(host: HostRequest, Query(query): Query<ChatStateQuery>) -> Response {
    host.json("chat.state", json!({"sessionKey": query.session_key}))
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatTranscriptQuery {
    session_key: String,
    start_message: Option<usize>,
    message_limit: Option<usize>,
    #[serde(default)]
    include_message_index: bool,
}

pub(super) async fn chat_transcript(
    host: HostRequest,
    Query(query): Query<ChatTranscriptQuery>,
) -> Response {
    host.json(
        "chat.transcript",
        json!({"sessionKey": query.session_key, "window": {
                "startMessage": query.start_message,
                "messageLimit": query.message_limit,
                "includeMessageIndex": query.include_message_index,
            },}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatRpcRequest {
    session_key: String,
    command: Value,
}

pub(super) async fn chat_rpc(host: HostRequest, Json(request): Json<ChatRpcRequest>) -> Response {
    host.no_content(
        "chat.rpc",
        json!({"sessionKey": request.session_key, "command": request.command}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatMcpApproveRequest {
    project_id: String,
    server_name: String,
}

pub(super) async fn chat_mcp_approve(
    host: HostRequest,
    Json(request): Json<ChatMcpApproveRequest>,
) -> Response {
    host.no_content(
        "chat.mcp.approve",
        json!({"projectId": request.project_id, "serverName": request.server_name}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileSearchQuery {
    project_id: String,
    query: String,
}

/// Read-only file-name search used to power `@` mentions in the Mobile
/// composer. It reuses the same `fs.search` host call as Desktop; no file
/// contents are exposed.
pub(super) async fn files_search(
    host: HostRequest,
    Query(query): Query<FileSearchQuery>,
) -> Response {
    host.json(
        "files.search",
        json!({"projectId": query.project_id, "query": query.query}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectImageQuery {
    project_id: String,
    path: String,
}

pub(super) async fn project_image(
    host: HostRequest,
    Query(query): Query<ProjectImageQuery>,
) -> Response {
    let params = json!({"projectId": query.project_id, "path": query.path});
    match host.binary("files.image", params, None).await {
        Ok(BinaryOutput::Bytes(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Body::from(bytes))
            .unwrap_or_else(|error| {
                api_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
            }),
        Ok(BinaryOutput::Json(_)) => {
            host_error(HostApiError::internal("expected project image bytes"))
        }
        Err(error) => host_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatFileUploadQuery {
    project_id: String,
    name: String,
}

pub(super) async fn chat_file_upload(
    host: HostRequest,
    Query(query): Query<ChatFileUploadQuery>,
    data: Bytes,
) -> Response {
    let params = json!({"projectId": query.project_id, "name": query.name});
    match host.binary("chat.files.upload", params, Some(&data)).await {
        Ok(BinaryOutput::Json(path)) => Json(path).into_response(),
        Ok(BinaryOutput::Bytes(_)) => {
            host_error(HostApiError::internal("expected an uploaded file path"))
        }
        Err(error) => host_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatFileRemoveQuery {
    project_id: String,
    path: String,
}

pub(super) async fn chat_file_remove(
    host: HostRequest,
    Query(query): Query<ChatFileRemoveQuery>,
) -> Response {
    host.no_content(
        "chat.files.remove",
        json!({"projectId": query.project_id, "path": query.path}),
    )
    .await
}
