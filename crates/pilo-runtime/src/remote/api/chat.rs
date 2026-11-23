use axum::{
    Json,
    body::{Body, Bytes},
    extract::Query,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    chat_service::{self, ChatSessionRequest},
    remote_fs,
    runtime_api::{chat_session_send_rpc, chat_session_state, chat_session_stop},
};

use super::{RemoteHttpState, api_error};

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
    state: RemoteHttpState,
    Json(request): Json<ChatStartRequest>,
) -> Response {
    if !request.builtin_extensions.is_empty()
        && (!request.no_session.unwrap_or(false)
            || request.session_path.is_some()
            || request.builtin_extensions.iter().any(|extension| {
                !matches!(extension, pilo_protocol::BuiltinExtension::ModelCatalog)
            }))
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "Remote catalog probes only support the model-catalog extension with noSession",
        );
    }
    let runtime = state.runtime.core.clone();
    let events = state.runtime.events.clone();
    let probe = !request.builtin_extensions.is_empty();
    let request = ChatSessionRequest {
        project_id: request.project_id,
        session_key: request.session_key,
        session_path: request.session_path,
        no_session: request.no_session.unwrap_or(false),
        extensions: Vec::new(),
        builtin_extensions: request.builtin_extensions,
    };
    let result = if probe {
        // Preparing a no-session probe must not send new_session or index an empty chat.
        chat_service::prepare(&state.runtime.paths, &runtime, events, request).await
    } else {
        chat_service::start(&state.runtime.paths, &runtime, events, request).await
    };
    match result {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
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

pub(super) async fn chat_stop(
    state: RemoteHttpState,
    Json(request): Json<ChatStopRequest>,
) -> Response {
    match chat_session_stop(&state.runtime, request.session_key, request.reason).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn chat_state(
    state: RemoteHttpState,
    Query(query): Query<ChatStateQuery>,
) -> Response {
    match chat_session_state(&state.runtime, query.session_key).await {
        Ok(session) => Json(session).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
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
    state: RemoteHttpState,
    Query(query): Query<ChatTranscriptQuery>,
) -> Response {
    let window = crate::TranscriptWindow {
        start_message: query.start_message,
        message_limit: query.message_limit,
        include_message_index: query.include_message_index,
    };
    match state
        .runtime
        .chat_transcript_snapshot(&query.session_key, window)
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatRpcRequest {
    session_key: String,
    command: Value,
}

pub(super) async fn chat_rpc(
    state: RemoteHttpState,
    Json(request): Json<ChatRpcRequest>,
) -> Response {
    if let Err(error) = super::validation::validate_remote_rpc(&request.command) {
        return api_error(StatusCode::BAD_REQUEST, &error);
    }
    match chat_session_send_rpc(&state.runtime, request.session_key, request.command).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatMcpApproveRequest {
    project_id: String,
    server_name: String,
}

pub(super) async fn chat_mcp_approve(
    state: RemoteHttpState,
    Json(request): Json<ChatMcpApproveRequest>,
) -> Response {
    match crate::runtime_api::project_mcp_server_approve(
        &state.runtime,
        request.project_id,
        request.server_name,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
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
    state: RemoteHttpState,
    Query(query): Query<FileSearchQuery>,
) -> Response {
    let runtime = state.runtime.core.clone();
    let project =
        match crate::project::ready(&state.runtime, &runtime.servers, &query.project_id).await {
            Ok(project) => project,
            Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
        };
    match remote_fs::search(&runtime.servers, &project, &query.query).await {
        Ok(paths) => Json(paths).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectImageQuery {
    project_id: String,
    path: String,
}

pub(super) async fn project_image(
    state: RemoteHttpState,
    Query(query): Query<ProjectImageQuery>,
) -> Response {
    let runtime = state.runtime.core.clone();
    let project =
        match crate::project::ready(&state.runtime, &runtime.servers, &query.project_id).await {
            Ok(project) => project,
            Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
        };
    match remote_fs::read_image(&runtime.servers, &project, &query.path).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Body::from(bytes))
            .unwrap_or_else(|error| {
                api_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
            }),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatFileUploadQuery {
    project_id: String,
    name: String,
}

pub(super) async fn chat_file_upload(
    state: RemoteHttpState,
    Query(query): Query<ChatFileUploadQuery>,
    data: Bytes,
) -> Response {
    let runtime = state.runtime.core.clone();
    let project =
        match crate::project::ready(&state.runtime, &runtime.servers, &query.project_id).await {
            Ok(project) => project,
            Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
        };
    match remote_fs::upload_chat_file(&runtime.servers, &project, &query.name, &data).await {
        Ok(path) => Json(path).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatFileRemoveQuery {
    project_id: String,
    path: String,
}

pub(super) async fn chat_file_remove(
    state: RemoteHttpState,
    Query(query): Query<ChatFileRemoveQuery>,
) -> Response {
    let runtime = state.runtime.core.clone();
    let project =
        match crate::project::ready(&state.runtime, &runtime.servers, &query.project_id).await {
            Ok(project) => project,
            Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
        };
    match remote_fs::remove_chat_file(&runtime.servers, &project, &query.path).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}
