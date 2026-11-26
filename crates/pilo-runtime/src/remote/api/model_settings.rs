use axum::{
    Json,
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use crate::storage;

use super::{RemoteHttpState, api_error, get_project};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelsQuery {
    project_id: String,
}

/// Project model and command catalog shared by Desktop and WebUI.
pub(super) async fn models(state: RemoteHttpState, Query(query): Query<ModelsQuery>) -> Response {
    let paths = state.runtime.paths.clone();
    let project_id = query.project_id;
    match tokio::task::spawn_blocking(move || {
        let db = storage::open_with_paths(&paths)?;
        storage::get_project_model_cache(&db, &project_id)
    })
    .await
    {
        Ok(Ok(cache)) => Json(cache).into_response(),
        Ok(Err(error)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to load project models: {error}"),
        ),
    }
}

pub(super) async fn models_set(
    state: RemoteHttpState,
    Json(mut cache): Json<pilo_domain::ProjectModelCache>,
) -> Response {
    if let Err(error) = get_project(&state.runtime.paths, &cache.project_id) {
        return api_error(StatusCode::NOT_FOUND, &error);
    }
    // Mobile and desktop clocks can differ; the Host owns cache ordering.
    cache.refreshed_at_ms = storage::now_ms();
    match storage::open_with_paths(&state.runtime.paths)
        .and_then(|db| storage::upsert_project_model_cache(&db, &cache))
    {
        Ok(()) => Json(cache).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn model_scope_get(
    state: RemoteHttpState,
    Query(query): Query<ModelsQuery>,
) -> Response {
    match crate::project::load_model_scope(&state.runtime, &query.project_id) {
        Ok(scope) => Json(scope).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelScopeRequest {
    project_id: String,
    models: Option<Vec<pilo_domain::ProjectScopedModel>>,
}

pub(super) async fn model_scope_set(
    state: RemoteHttpState,
    Json(request): Json<ModelScopeRequest>,
) -> Response {
    match crate::project::save_model_scope(
        &state.runtime,
        &state.runtime.events,
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

pub(super) async fn connection_models(
    state: RemoteHttpState,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    match crate::connections::connection_models_get(&state.runtime, query.connection_id).await {
        Ok(models) => Json(models).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn next_prompt_settings_get(
    state: RemoteHttpState,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    match crate::next_prompt::load(&state.runtime.paths, &query.connection_id) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NextPromptSettingsInput {
    connection_id: String,
    enabled: bool,
    model: Option<pilo_domain::NextPromptModel>,
}

pub(super) async fn next_prompt_settings_set(
    state: RemoteHttpState,
    Json(input): Json<NextPromptSettingsInput>,
) -> Response {
    match crate::next_prompt::save(
        &state.runtime.paths,
        &state.runtime.events,
        &input.connection_id,
        input.enabled,
        input.model,
    ) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn next_prompt_request(
    state: RemoteHttpState,
    Json(request): Json<pilo_domain::NextPromptRequest>,
) -> Response {
    match crate::next_prompt::request(&state.runtime.paths, &state.runtime.core, request).await {
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
    state: RemoteHttpState,
    Query(query): Query<PromptEnhancementSettingsQuery>,
) -> Response {
    match crate::prompt_enhancement::load(&state.runtime.paths, &query.connection_id) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptEnhancementSettingsInput {
    connection_id: String,
    enabled: bool,
    model: Option<pilo_domain::PromptEnhancementModel>,
}

pub(super) async fn prompt_enhancement_settings_set(
    state: RemoteHttpState,
    Json(input): Json<PromptEnhancementSettingsInput>,
) -> Response {
    match crate::prompt_enhancement::save(
        &state.runtime.paths,
        &state.runtime.events,
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
    model: Option<pilo_domain::PromptEnhancementModel>,
}

/// The Host's budget covers process start, the RPC, generation and cleanup, so
/// it returns a real reason instead of the Router's generic 408.
pub(super) async fn prompt_enhance(
    state: RemoteHttpState,
    Json(input): Json<PromptEnhanceInput>,
) -> Response {
    match crate::prompt_enhancement::enhance(
        &state.runtime,
        &state.runtime.paths,
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
    state: RemoteHttpState,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    match crate::cache_keep_alive::load(&state.runtime.paths, &query.connection_id) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn cache_keep_alive_settings_set(
    state: RemoteHttpState,
    Json(settings): Json<pilo_domain::CacheKeepAliveSettings>,
) -> Response {
    match crate::cache_keep_alive::save(
        &state.runtime.paths,
        &state.runtime.core,
        &state.runtime.events,
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
pub(super) struct PauseCacheKeepAliveRequest {
    session_key: String,
}

pub(super) async fn cache_keep_alive_pause(
    state: RemoteHttpState,
    Json(body): Json<PauseCacheKeepAliveRequest>,
) -> Response {
    match crate::cache_keep_alive::cache_keep_alive_pause(&state.runtime, body.session_key).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}
