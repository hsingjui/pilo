use axum::{
    Json,
    body::Body,
    extract::Query,
    http::{StatusCode, header},
    response::Response,
};
use serde::Deserialize;

use serde_json::json;

use crate::{
    events::LIVE_IMAGE_PREFIX,
    host_api::{self, BinaryOutput, HostApiError},
};

use super::{HostRequest, api_error, host_error};

pub(super) async fn session_read_states(host: HostRequest) -> Response {
    host.json("session.readStates", json!({})).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionReadRequest {
    project_id: String,
    session_path: String,
    revision: u64,
}

pub(super) async fn session_mark_read(
    host: HostRequest,
    Json(request): Json<SessionReadRequest>,
) -> Response {
    host.json("session.markRead", json!({"projectId": request.project_id, "sessionPath": request.session_path, "revision": request.revision})).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionsQuery {
    project_id: String,
    #[serde(default)]
    cached: bool,
}

pub(super) async fn sessions(host: HostRequest, Query(query): Query<SessionsQuery>) -> Response {
    host.json(
        "session.list",
        json!({"projectId": query.project_id, "cached": query.cached}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionSearchQuery {
    project_id: String,
    query: String,
    limit: Option<usize>,
}

pub(super) async fn sessions_search(
    host: HostRequest,
    Query(query): Query<SessionSearchQuery>,
) -> Response {
    host.json(
        "session.search",
        json!({"projectId": query.project_id, "query": query.query,
            "limit": query.limit.unwrap_or(24).clamp(1, 100),}),
    )
    .await
}

pub(super) async fn sessions_external_activity(
    host: HostRequest,
    Query(query): Query<SessionsQuery>,
) -> Response {
    host.json(
        "session.externalActivity",
        json!({"projectId": query.project_id}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryQuery {
    project_id: String,
    session_path: String,
    start_message: Option<usize>,
    message_limit: Option<usize>,
    include_message_index: Option<bool>,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
}

pub(super) async fn history(host: HostRequest, Query(query): Query<HistoryQuery>) -> Response {
    let params = json!({
        "projectId": query.project_id, "sessionPath": query.session_path,
        "expectedFileSize": query.expected_file_size, "expectedFileMtimeNs": query.expected_file_mtime_ns,
        "startMessage": query.start_message, "messageLimit": query.message_limit.unwrap_or(200).clamp(1, 400),
        "includeMessageIndex": query.include_message_index,
    });
    match host_api::call_json_bytes(&host.runtime, &host.principal, "session.history", params).await
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
        Err(error) => host_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryImageQuery {
    project_id: String,
    session_path: String,
    image_id: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
}

pub(super) async fn history_image(
    host: HostRequest,
    Query(query): Query<HistoryImageQuery>,
) -> Response {
    let live = query.image_id.starts_with(LIVE_IMAGE_PREFIX);
    let params = json!({
        "projectId": query.project_id, "sessionPath": query.session_path, "imageId": query.image_id,
        "expectedFileSize": query.expected_file_size, "expectedFileMtimeNs": query.expected_file_mtime_ns,
    });
    match host.binary("session.historyImage", params, None).await {
        Ok(BinaryOutput::Bytes(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(
                header::CACHE_CONTROL,
                if live {
                    "no-store"
                } else {
                    "private, max-age=31536000, immutable"
                },
            )
            .body(Body::from(bytes))
            .unwrap_or_else(|error| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("failed to build history image response: {error}"),
                )
            }),
        Ok(BinaryOutput::Json(_)) => {
            host_error(HostApiError::internal("expected history image bytes"))
        }
        Err(error) => host_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionTitleRequest {
    project_id: String,
    message: String,
}

pub(super) async fn session_title(
    host: HostRequest,
    Json(request): Json<SessionTitleRequest>,
) -> Response {
    host.json(
        "session.title",
        json!({"projectId": request.project_id, "message": request.message}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionDeleteRequest {
    project_id: String,
    session_path: String,
}

/// Mobile WebUI 的会话删除。复用桌面的 `session_delete` 命令，保证
/// 索引清理与历史缓存失效走同一条路径。
pub(super) async fn session_delete(
    host: HostRequest,
    Json(request): Json<SessionDeleteRequest>,
) -> Response {
    host.json(
        "session.delete",
        json!({"projectId": request.project_id, "sessionPath": request.session_path}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionUiStateRequest {
    project_id: Option<String>,
    session_path: String,
    update: pilo_domain::SessionUiStateUpdate,
}

/// Mobile WebUI 的会话重命名、归档及其他 UI 状态更新。
pub(super) async fn session_ui_state(
    host: HostRequest,
    Json(request): Json<SessionUiStateRequest>,
) -> Response {
    host.json("session.uiState.set", json!({"projectId": request.project_id, "sessionPath": request.session_path, "update": request.update})).await
}
