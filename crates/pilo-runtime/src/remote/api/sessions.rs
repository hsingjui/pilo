use axum::{
    Json,
    body::Body,
    extract::Query,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use crate::{pi_workspace, session_history};

use super::{RemoteHttpState, api_error, get_project};

pub(super) async fn session_read_states(state: RemoteHttpState) -> Response {
    match crate::handle::session_read_states(&state.runtime).await {
        Ok(states) => Json(states).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionReadRequest {
    project_id: String,
    session_path: String,
    revision: u64,
}

pub(super) async fn session_mark_read(
    state: RemoteHttpState,
    Json(request): Json<SessionReadRequest>,
) -> Response {
    match crate::handle::session_mark_read(
        &state.runtime,
        request.project_id,
        request.session_path,
        request.revision,
    )
    .await
    {
        Ok(read_state) => Json(read_state).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionsQuery {
    project_id: String,
    #[serde(default)]
    cached: bool,
}

pub(super) async fn sessions(
    state: RemoteHttpState,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.runtime.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    if query.cached {
        return match crate::session_api::session_list(&state.runtime, project.id) {
            Ok(sessions) => Json(sessions).into_response(),
            Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
    }
    match crate::session_api::session_reconcile(&state.runtime, project.id).await {
        Ok(result) => Json(result.sessions).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionSearchQuery {
    project_id: String,
    query: String,
    limit: Option<usize>,
}

pub(super) async fn sessions_search(
    state: RemoteHttpState,
    Query(query): Query<SessionSearchQuery>,
) -> Response {
    match crate::session_api::session_search(
        &state.runtime,
        query.project_id,
        query.query,
        Some(query.limit.unwrap_or(24).clamp(1, 100)),
    )
    .await
    {
        Ok(matches) => Json(matches).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn sessions_external_activity(
    state: RemoteHttpState,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.runtime.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.runtime.paths, &project)
    }) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    match state
        .runtime
        .events
        .external_session_activity(&state.runtime, &project)
        .await
    {
        Ok(activities) => Json(activities).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
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

pub(super) async fn history(state: RemoteHttpState, Query(query): Query<HistoryQuery>) -> Response {
    let project = match get_project(&state.runtime.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.runtime.paths, &project)
    }) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.runtime.core.clone();
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
pub(super) struct HistoryImageQuery {
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

pub(super) async fn history_image(
    state: RemoteHttpState,
    Query(query): Query<HistoryImageQuery>,
) -> Response {
    let project = match get_project(&state.runtime.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.runtime.paths, &project)
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
    let runtime = state.runtime.core.clone();
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
pub(super) struct SessionTitleRequest {
    project_id: String,
    message: String,
}

pub(super) async fn session_title(
    state: RemoteHttpState,
    Json(request): Json<SessionTitleRequest>,
) -> Response {
    let runtime = state.runtime.clone();
    match crate::session_naming::generate_session_title(
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
pub(super) struct SessionDeleteRequest {
    project_id: String,
    session_path: String,
}

/// Mobile WebUI 的会话删除。复用桌面的 `session_delete` 命令，保证
/// 索引清理与历史缓存失效走同一条路径。
pub(super) async fn session_delete(
    state: RemoteHttpState,
    Json(request): Json<SessionDeleteRequest>,
) -> Response {
    match crate::session_api::session_delete(
        &state.runtime,
        request.project_id,
        request.session_path,
    )
    .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionUiStateRequest {
    project_id: Option<String>,
    session_path: String,
    update: pilo_domain::SessionUiStateUpdate,
}

/// Mobile WebUI 的会话重命名 / UI 状态更新。
pub(super) async fn session_ui_state(
    state: RemoteHttpState,
    Json(request): Json<SessionUiStateRequest>,
) -> Response {
    match crate::session_api::session_update_ui_state(
        &state.runtime,
        request.session_path,
        request.update,
        request.project_id,
    ) {
        Ok(entry) => Json(entry).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}
