use axum::{
    Json,
    extract::Query,
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use serde_json::json;

use super::{HostRequest, host_error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelsQuery {
    project_id: String,
}

/// Project model and command catalog shared by Desktop and WebUI.
pub(super) async fn models(host: HostRequest, Query(query): Query<ModelsQuery>) -> Response {
    host.json("models.get", json!({"projectId": query.project_id}))
        .await
}

pub(super) async fn models_set(
    host: HostRequest,
    Json(cache): Json<pilo_domain::ProjectModelCache>,
) -> Response {
    host.json("models.set", json!({"cache": cache})).await
}

pub(super) async fn model_scope_get(
    host: HostRequest,
    Query(query): Query<ModelsQuery>,
) -> Response {
    host.json("models.scope.get", json!({"projectId": query.project_id}))
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelScopeRequest {
    project_id: String,
    models: Option<Vec<pilo_domain::ProjectScopedModel>>,
}

pub(super) async fn model_scope_set(
    host: HostRequest,
    Json(request): Json<ModelScopeRequest>,
) -> Response {
    host.json(
        "models.scope.set",
        json!({"projectId": request.project_id, "models": request.models}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NextPromptSettingsQuery {
    connection_id: String,
}

pub(super) async fn connection_models(
    host: HostRequest,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    host.json(
        "connection.models",
        json!({"connectionId": query.connection_id}),
    )
    .await
}

pub(super) async fn next_prompt_settings_get(
    host: HostRequest,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    host.json(
        "nextPrompt.settings.get",
        json!({"connectionId": query.connection_id}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NextPromptSettingsInput {
    connection_id: String,
    enabled: bool,
    model: Option<pilo_domain::NextPromptModel>,
}

pub(super) async fn next_prompt_settings_set(
    host: HostRequest,
    Json(input): Json<NextPromptSettingsInput>,
) -> Response {
    host.json("nextPrompt.settings.set", json!({"connectionId": input.connection_id, "enabled": input.enabled, "model": input.model})).await
}

pub(super) async fn next_prompt_request(
    host: HostRequest,
    Json(request): Json<pilo_domain::NextPromptRequest>,
) -> Response {
    match host
        .call("nextPrompt.request", json!({"request": request}))
        .await
    {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(error) => host_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptEnhancementSettingsQuery {
    connection_id: String,
}

pub(super) async fn prompt_enhancement_settings_get(
    host: HostRequest,
    Query(query): Query<PromptEnhancementSettingsQuery>,
) -> Response {
    host.json(
        "promptEnhancement.settings.get",
        json!({"connectionId": query.connection_id}),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptEnhancementSettingsInput {
    connection_id: String,
    enabled: bool,
    model: Option<pilo_domain::PromptEnhancementModel>,
}

pub(super) async fn prompt_enhancement_settings_set(
    host: HostRequest,
    Json(input): Json<PromptEnhancementSettingsInput>,
) -> Response {
    host.json("promptEnhancement.settings.set", json!({"connectionId": input.connection_id, "enabled": input.enabled, "model": input.model})).await
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
    host: HostRequest,
    Json(input): Json<PromptEnhanceInput>,
) -> Response {
    host.json(
        "promptEnhancement.enhance",
        json!({"projectId": input.project_id, "draft": input.draft, "model": input.model}),
    )
    .await
}

pub(super) async fn cache_keep_alive_settings_list(
    host: HostRequest,
    Query(query): Query<NextPromptSettingsQuery>,
) -> Response {
    host.json(
        "cacheKeepAlive.settings.list",
        json!({"connectionId": query.connection_id}),
    )
    .await
}

pub(super) async fn cache_keep_alive_settings_set(
    host: HostRequest,
    Json(settings): Json<pilo_domain::CacheKeepAliveSettings>,
) -> Response {
    host.json("cacheKeepAlive.settings.set", json!({"settings": settings}))
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PauseCacheKeepAliveRequest {
    session_key: String,
}

pub(super) async fn cache_keep_alive_pause(
    host: HostRequest,
    Json(body): Json<PauseCacheKeepAliveRequest>,
) -> Response {
    host.no_content(
        "cacheKeepAlive.pause",
        json!({"sessionKey": body.session_key}),
    )
    .await
}
