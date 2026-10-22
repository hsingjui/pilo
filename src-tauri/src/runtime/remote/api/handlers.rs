use axum::{
    Json,
    body::{Body, Bytes},
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
    pi_workspace, remote_fs, session_history, storage,
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

pub(super) async fn preferences_get(State(state): State<RemoteHttpState>) -> Response {
    match crate::runtime::preferences::load(&state.app) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn preferences_patch(
    State(state): State<RemoteHttpState>,
    Json(patch): Json<serde_json::Map<String, Value>>,
) -> Response {
    match crate::runtime::preferences::save(
        &state.app,
        &state.app.state::<RuntimeEventBus>(),
        patch,
        false,
    ) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn theme_settings(State(state): State<RemoteHttpState>) -> Response {
    match crate::runtime::appearance::load(
        state.app.clone(),
        state.app.state::<RuntimeEventBus>().inner().clone(),
        None,
    )
    .await
    {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn theme_settings_set(
    State(state): State<RemoteHttpState>,
    Json(update): Json<crate::domain::ThemeSettingsUpdate>,
) -> Response {
    match crate::runtime::appearance::save(
        state.app.clone(),
        state.app.state::<RuntimeEventBus>().inner().clone(),
        update,
    )
    .await
    {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn session_read_states(State(state): State<RemoteHttpState>) -> Response {
    match crate::runtime::commands::session_read_states(state.app.state::<RuntimeEventBus>()).await
    {
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
    State(state): State<RemoteHttpState>,
    Json(request): Json<SessionReadRequest>,
) -> Response {
    match crate::runtime::commands::session_mark_read(
        state.app.state::<RuntimeEventBus>(),
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    if query.cached {
        return match crate::runtime::commands::session_list(state.app.clone(), project.id) {
            Ok(sessions) => Json(sessions).into_response(),
            Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
    }
    match crate::runtime::commands::session_reconcile(
        state.app.clone(),
        state.app.state::<PiloRuntime>(),
        project.id,
    )
    .await
    {
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<SessionSearchQuery>,
) -> Response {
    match crate::runtime::commands::session_search(
        state.app.clone(),
        state.app.state::<PiloRuntime>(),
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<SessionsQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id).and_then(|project| {
        pi_workspace::resolve_session_project_with_paths(&state.paths, &project)
    }) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match state
        .app
        .state::<RuntimeEventBus>()
        .external_session_activity(&runtime, &project)
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
pub(super) struct ProjectImageQuery {
    project_id: String,
    path: String,
}

pub(super) async fn project_image(
    State(state): State<RemoteHttpState>,
    Query(query): Query<ProjectImageQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<ChatFileUploadQuery>,
    data: Bytes,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
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
    State(state): State<RemoteHttpState>,
    Query(query): Query<ChatFileRemoveQuery>,
) -> Response {
    let project = match get_project(&state.paths, &query.project_id) {
        Ok(project) => project,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error),
    };
    let runtime = state.app.state::<PiloRuntime>();
    match remote_fs::remove_chat_file(&runtime.servers, &project, &query.path).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
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

/// Project model and command catalog shared by Desktop and WebUI.
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

pub(super) async fn models_set(
    State(state): State<RemoteHttpState>,
    Json(mut cache): Json<crate::domain::ProjectModelCache>,
) -> Response {
    if let Err(error) = get_project(&state.paths, &cache.project_id) {
        return api_error(StatusCode::NOT_FOUND, &error);
    }
    // Mobile and desktop clocks can differ; the Host owns cache ordering.
    cache.refreshed_at_ms = storage::now_ms();
    match storage::open_with_paths(&state.paths)
        .and_then(|db| storage::upsert_project_model_cache(&db, &cache))
    {
        Ok(()) => Json(cache).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn model_scope_get(
    State(state): State<RemoteHttpState>,
    Query(query): Query<ModelsQuery>,
) -> Response {
    match crate::runtime::project::load_model_scope(&state.app, &query.project_id) {
        Ok(scope) => Json(scope).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelScopeRequest {
    project_id: String,
    models: Option<Vec<crate::domain::ProjectScopedModel>>,
}

pub(super) async fn model_scope_set(
    State(state): State<RemoteHttpState>,
    Json(request): Json<ModelScopeRequest>,
) -> Response {
    match crate::runtime::project::save_model_scope(
        &state.app,
        &state.app.state::<RuntimeEventBus>(),
        &request.project_id,
        request.models,
    ) {
        Ok(scope) => Json(scope).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NextPromptSettingsQuery {
    connection_id: String,
}

pub(super) async fn next_prompt_settings_get(
    State(state): State<RemoteHttpState>,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    match crate::runtime::next_prompt::load(&state.paths, &query.connection_id) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NextPromptSettingsInput {
    connection_id: String,
    enabled: bool,
    model: Option<crate::domain::NextPromptModel>,
}

pub(super) async fn next_prompt_settings_set(
    State(state): State<RemoteHttpState>,
    Json(input): Json<NextPromptSettingsInput>,
) -> Response {
    match crate::runtime::next_prompt::save(
        &state.paths,
        &state.app.state::<RuntimeEventBus>(),
        &input.connection_id,
        input.enabled,
        input.model,
    ) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn next_prompt_request(
    State(state): State<RemoteHttpState>,
    Json(request): Json<crate::domain::NextPromptRequest>,
) -> Response {
    match crate::runtime::next_prompt::request(
        &state.paths,
        &state.app.state::<PiloRuntime>(),
        request,
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptEnhancementSettingsQuery {
    connection_id: String,
}

pub(super) async fn prompt_enhancement_settings_get(
    State(state): State<RemoteHttpState>,
    Query(query): Query<PromptEnhancementSettingsQuery>,
) -> Response {
    match crate::runtime::prompt_enhancement::load(&state.paths, &query.connection_id) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptEnhancementSettingsInput {
    connection_id: String,
    enabled: bool,
    model: Option<crate::domain::PromptEnhancementModel>,
}

pub(super) async fn prompt_enhancement_settings_set(
    State(state): State<RemoteHttpState>,
    Json(input): Json<PromptEnhancementSettingsInput>,
) -> Response {
    match crate::runtime::prompt_enhancement::save(
        &state.paths,
        &state.app.state::<RuntimeEventBus>(),
        &input.connection_id,
        input.enabled,
        input.model,
    ) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptEnhanceInput {
    project_id: String,
    draft: String,
    model: Option<crate::domain::PromptEnhancementModel>,
}

/// The Host's budget covers process start, the RPC, generation and cleanup, so
/// it returns a real reason instead of the Router's generic 408.
pub(super) async fn prompt_enhance(
    State(state): State<RemoteHttpState>,
    Json(input): Json<PromptEnhanceInput>,
) -> Response {
    match crate::runtime::prompt_enhancement::enhance(
        &state.app,
        &state.app.state::<PiloRuntime>(),
        &state.paths,
        &input.project_id,
        &input.draft,
        input.model,
    )
    .await
    {
        Ok(text) => Json(text).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn cache_keep_alive_settings_list(
    State(state): State<RemoteHttpState>,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    match crate::runtime::cache_keep_alive::load(&state.paths, &query.connection_id) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn cache_keep_alive_settings_set(
    State(state): State<RemoteHttpState>,
    Json(settings): Json<crate::domain::CacheKeepAliveSettings>,
) -> Response {
    match crate::runtime::cache_keep_alive::save(
        &state.paths,
        &state.app.state::<PiloRuntime>(),
        &state.app.state::<RuntimeEventBus>(),
        settings,
    )
    .await
    {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

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
    State(state): State<RemoteHttpState>,
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
    let runtime = state.app.state::<PiloRuntime>();
    let events = state.app.state::<RuntimeEventBus>().inner().clone();
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
        chat_service::prepare(&state.paths, &runtime, events, request).await
    } else {
        chat_service::start(&state.paths, &runtime, events, request).await
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
    State(state): State<RemoteHttpState>,
    Json(request): Json<ChatStopRequest>,
) -> Response {
    let runtime = state.app.state::<PiloRuntime>();
    match runtime
        .chat_sessions
        .stop(&request.session_key, request.reason.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
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
pub(super) struct ChatMcpApproveRequest {
    project_id: String,
    server_name: String,
}

pub(super) async fn chat_mcp_approve(
    State(state): State<RemoteHttpState>,
    Json(request): Json<ChatMcpApproveRequest>,
) -> Response {
    match crate::runtime::commands::project_mcp_server_approve(
        state.app.clone(),
        state.app.state::<PiloRuntime>(),
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
