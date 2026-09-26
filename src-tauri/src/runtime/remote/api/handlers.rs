use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use tauri::Manager;

use crate::runtime::{
    PiloRuntime, RuntimeEventBus,
    chat_service::{self, ChatSessionRequest},
    pi_workspace, remote_fs, session_activity, session_history, session_index, storage,
};

use super::{RemoteHttpState, api_error, get_project};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BootstrapResponse {
    projects: Vec<crate::domain::Project>,
    chat_sessions: Vec<crate::runtime::chat_sessions::ChatSessionState>,
    latest_sequence: u64,
}

pub(super) async fn bootstrap(State(state): State<RemoteHttpState>) -> Response {
    let projects =
        match storage::open_with_paths(&state.paths).and_then(|db| storage::list_projects(&db)) {
            Ok(projects) => projects,
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
    let runtime = state.app.state::<PiloRuntime>();
    let events = state.app.state::<RuntimeEventBus>();
    Json(BootstrapResponse {
        projects,
        chat_sessions: runtime.chat_sessions.states().await,
        latest_sequence: events.latest_sequence(),
    })
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionsQuery {
    project_id: String,
}

pub(super) async fn sessions(
    State(state): State<RemoteHttpState>,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match session_index::reconcile(&state.app, &runtime.servers, &project).await {
        Ok(work) => Json(work.result.sessions).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn sessions_external_activity(
    State(state): State<RemoteHttpState>,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match session_activity::external_session_activities_for_project(&runtime, &project).await {
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

pub(super) async fn history(
    State(state): State<RemoteHttpState>,
    Query(query): Query<HistoryQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.paths, &project)
    }) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<HistoryImageQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.paths, &project)
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
    let runtime = state.app.state::<PiloRuntime>();
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
    State(state): State<RemoteHttpState>,
    Json(request): Json<SessionTitleRequest>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    match crate::runtime::commands::generate_session_title(
        &state.app,
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
    State(state): State<RemoteHttpState>,
    Json(request): Json<SessionDeleteRequest>,
) -> Response {
    match crate::runtime::commands::session_delete(
        state.app.clone(),
        state.app.state::<PiloRuntime>(),
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
pub(super) struct ModelsQuery {
    project_id: String,
}

/// Read-only model catalog used by the Remote WebUI composer. The Desktop
/// client already keeps `project_model_cache` fresh through its Pi probe
/// sessions; Remote reuses that snapshot instead of spawning its own probe.
pub(super) async fn models(
    State(state): State<RemoteHttpState>,
    Query(query): Query<ModelsQuery>,
) -> Response {
    match storage::open_with_paths(&state.paths)
        .and_then(|db| storage::list_project_model_cache(&db))
    {
        Ok(caches) => {
            let cache = caches
                .into_iter()
                .find(|cache| cache.project_id == query.project_id);
            Json(cache).into_response()
        }
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatStartRequest {
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: Option<bool>,
}

pub(super) async fn chat_start(
    State(state): State<RemoteHttpState>,
    Json(request): Json<ChatStartRequest>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    let events = state.app.state::<RuntimeEventBus>().inner().clone();
    match chat_service::start(
        &state.paths,
        &runtime,
        events,
        ChatSessionRequest {
            project_id: request.project_id,
            session_key: request.session_key,
            session_path: request.session_path,
            no_session: request.no_session.unwrap_or(false),
            extensions: Vec::new(),
        },
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatStateQuery {
    session_key: String,
}

pub(super) async fn chat_state(
    State(state): State<RemoteHttpState>,
    Query(query): Query<ChatStateQuery>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    Json(runtime.chat_sessions.state(&query.session_key).await).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatRpcRequest {
    session_key: String,
    command: Value,
}

pub(super) async fn chat_rpc(
    State(state): State<RemoteHttpState>,
    Json(request): Json<ChatRpcRequest>,
) -> Response {
    if let Err(error) = super::validation::validate_remote_rpc(&request.command) {
        return api_error(StatusCode::BAD_REQUEST, &error);
    }
    let runtime = state.app.state::<PiloRuntime>();
    match runtime
        .chat_sessions
        .send(&request.session_key, request.command)
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<FileSearchQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match remote_fs::search(&runtime.servers, &project, &query.query).await {
        Ok(paths) => Json(paths).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}
