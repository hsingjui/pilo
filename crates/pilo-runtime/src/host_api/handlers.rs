use pilo_domain::{
    CacheKeepAliveSettings, Connection, NextPromptModel, NextPromptRequest, ProjectModelCache,
    ProjectScopedModel, PromptEnhancementModel, RemoteAccessAddress, SessionUiStateUpdate,
    ThemeSettingsUpdate,
};
use pilo_protocol::{BuiltinExtension, MAX_BINARY_PAYLOAD_BYTES, MAX_CHAT_FILE_BYTES};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{
    Runtime, TranscriptWindow, appearance, bootstrap, cache_keep_alive,
    chat_service::{self, ChatSessionRequest},
    connections::{self, ssh, wsl},
    handle, next_prompt, pi_workspace, preferences, project, project_api, prompt_enhancement,
    remote, remote_fs, runtime_api, session_api, session_naming, storage,
};

use super::{
    CallFuture, HostApiError, Limits, MethodKind, MethodSpec, Output, Principal, Scope, blocking,
    decode, json, validation,
};

macro_rules! register {
    ($(
        $name:literal : $scope:ident $kind:ident $(($limit:expr))?
        |$rt:ident, $who:ident $(, $body:ident)?| ($($field:ident : $ty:ty),* $(,)?)
        $run:block
    )+) => {
        pub fn methods() -> &'static [MethodSpec] {
            static METHODS: &[MethodSpec] = &[$(MethodSpec {
                name: $name,
                scope: Scope::$scope,
                kind: MethodKind::$kind,
                limits: register!(@limits $kind $(($limit))?),
            }),+];
            METHODS
        }

        pub(super) fn dispatch<'a>(
            rt: &'a Runtime,
            who: &'a Principal,
            name: &str,
            params: Value,
            binary: Option<&'a [u8]>,
        ) -> CallFuture<'a> {
            match name {
                $($name => Box::pin(async move {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Params { $($field: $ty),* }
                    let Params { $($field),* } = decode(params)?;
                    let ($rt, $who) = (rt, who);
                    $(let $body = binary.expect("binary input was checked");)?
                    $run
                }),)+
                _ => unreachable!("dispatch only receives registered methods"),
            }
        }
    };
    (@limits Json) => { Limits::JSON };
    (@limits BinaryOut) => { Limits::JSON };
    (@limits BinaryIn ($limit:expr)) => { Limits::binary_input($limit) };
}

register! {
    "host.bootstrap": Chat Json |rt, _who| (
        include_preferences: Option<bool>, include_ui_state: Option<bool>,
        include_local_pi_resources: Option<bool>,
    ) {
        json(bootstrap::load(rt, include_preferences.unwrap_or(true), include_ui_state.unwrap_or(false),
            include_local_pi_resources.unwrap_or(false)).await.map_err(HostApiError::internal)?)
    }
    "host.shutdown": Admin Json |rt, _who| () {
        rt.shutdown().await;
        json(())
    }
    "project.list": Chat Json |rt, _who| () {
        json(database(rt, project_api::project_list).await?)
    }
    "project.add": Workspace Json |rt, _who| (connection_id: String, path: String) {
        json(project_api::project_add(rt, connection_id, path).await.map_err(HostApiError::invalid)?)
    }
    "project.remove": Workspace Json |rt, _who| (project_id: String) {
        json(project_api::project_remove(rt, project_id).await.map_err(HostApiError::invalid)?)
    }
    "project.file.preview": Workspace Json |rt, _who| (project_id: String, url: String) {
        json(project_api::project_file_link_open(rt, project_id, url, true).await.map_err(HostApiError::invalid)?)
    }
    "git.status": Workspace Json |rt, _who| (project_id: String) {
        json(project_api::project_git_status(rt, project_id).await.map_err(HostApiError::invalid)?)
    }
    "git.diff": Workspace Json |rt, _who| (project_id: String, path: Option<String>, staged: bool) {
        json(project_api::project_git_diff(rt, project_id, path, staged).await.map_err(HostApiError::invalid)?)
    }
    "terminal.open": Workspace Json |rt, _who| (project_id: String, cols: u16, rows: u16) {
        validate_terminal_size(cols, rows)?;
        json(project_api::project_terminal_open(rt, project_id, cols, rows).await.map_err(HostApiError::invalid)?)
    }
    "terminal.write": Workspace BinaryIn(MAX_BINARY_PAYLOAD_BYTES) |rt, _who, data| (terminal_id: String) {
        rt.terminals.write(&terminal_id, data).await.map_err(HostApiError::invalid)?;
        json(())
    }
    "terminal.resize": Workspace Json |rt, _who| (terminal_id: String, cols: u16, rows: u16) {
        validate_terminal_size(cols, rows)?;
        json(project_api::terminal_resize(rt, terminal_id, cols, rows).await.map_err(HostApiError::invalid)?)
    }
    "terminal.close": Workspace Json |rt, _who| (terminal_id: String) {
        json(project_api::terminal_close(rt, terminal_id).await.map_err(HostApiError::invalid)?)
    }

    "connection.list": Chat Json |rt, _who| () {
        json(database(rt, list_connections).await?)
    }
    "connection.local.get": Chat Json |rt, _who| () {
        json(database(rt, connections::local_connection_get).await?)
    }
    "connection.health": Chat Json |rt, _who| (id: String) {
        json(connections::connection_health_get(rt, id).await.map_err(HostApiError::internal)?)
    }
    "connection.models": Chat Json |rt, _who| (connection_id: String) {
        json(connections::connection_models_get(rt, connection_id).await.map_err(HostApiError::invalid)?)
    }
    "connection.namingModels.list": Chat Json |rt, _who| () {
        json(database(rt, connections::connection_naming_model_list).await?)
    }
    "connection.namingModels.set": Chat Json |rt, _who| (connection_id: String, provider: Option<String>, model_id: Option<String>) {
        json(database(rt, move |rt| connections::connection_naming_model_set(rt, connection_id, provider, model_id)).await?)
    }
    "connection.readDir": Workspace Json |rt, _who| (connection_id: String, path: String) {
        json(project_api::connection_fs_read_dir(rt, connection_id, path).await.map_err(HostApiError::invalid)?)
    }
    "connection.settings.update": Admin Json |rt, _who| (id: String, name: String, pi_executable: Option<String>) {
        json(database(rt, move |rt| connections::connection_settings_update(rt, id, name, pi_executable)).await?)
    }
    "connection.shownInHome.set": Admin Json |rt, _who| (id: String, shown: bool) {
        json(database(rt, move |rt| connections::connection_shown_in_home_set(rt, id, shown)).await?)
    }
    "connection.pi.probe": Admin Json |rt, _who| (id: String, executable: Option<String>) {
        json(connections::connection_pi_probe(rt, id, executable).await.map_err(HostApiError::invalid)?)
    }
    "connection.local.test": Admin Json |rt, _who| () {
        json(connections::local_connection_test(rt).await.map_err(HostApiError::invalid)?)
    }
    "connection.localPiResources.set": Admin Json |rt, _who| (connection_id: String, enabled: bool) {
        json(pi_workspace::set_local_pi_resources(rt, &connection_id, enabled).await.map_err(HostApiError::invalid)?)
    }
    "connection.ssh.list": Chat Json |rt, _who| () {
        json(database(rt, ssh::ssh_connection_list).await?)
    }
    "connection.ssh.agentIdentities": Admin Json |rt, _who| () {
        json(ssh::ssh_agent_identities_list(rt).await.map_err(HostApiError::internal)?)
    }
    "connection.ssh.configHosts": Admin Json |rt, _who| () {
        json(database(rt, ssh::ssh_config_hosts_list).await?)
    }
    "connection.ssh.localKeys": Admin Json |rt, _who| () {
        json(database(rt, ssh::ssh_local_keys_list).await?)
    }
    "connection.ssh.save": Admin Json |rt, _who| (request: ssh::SaveSshConnectionRequest) {
        json(ssh::ssh_connection_save(rt, request).await.map_err(HostApiError::invalid)?)
    }
    "connection.ssh.password": Admin Json |rt, _who| (id: String) {
        json(database(rt, move |rt| ssh::ssh_connection_password_get(rt, id)).await?)
    }
    "connection.ssh.remove": Admin Json |rt, _who| (id: String) {
        json(ssh::ssh_connection_remove(rt, id).await.map_err(HostApiError::invalid)?)
    }
    "connection.ssh.test": Admin Json |rt, _who| (id: String) {
        json(ssh::ssh_connection_test(rt, id).await.map_err(HostApiError::invalid)?)
    }
    "connection.ssh.testDraft": Admin Json |rt, _who| (connection: Connection, password: Option<String>) {
        json(ssh::ssh_connection_test_draft(rt, connection, password).await.map_err(HostApiError::invalid)?)
    }
    "connection.wsl.distributions": Admin Json |rt, _who| () {
        json(wsl::wsl_list_distributions(rt).await.map_err(|err| HostApiError::invalid(err.to_string()))?)
    }
    "connection.wsl.list": Chat Json |rt, _who| () {
        json(database(rt, wsl::wsl_connection_list).await?)
    }
    "connection.wsl.save": Admin Json |rt, _who| (connection: Connection) {
        json(database(rt, move |rt| wsl::wsl_connection_save(rt, connection)).await?)
    }
    "connection.wsl.remove": Admin Json |rt, _who| (id: String) {
        json(wsl::wsl_connection_remove(rt, id).await.map_err(HostApiError::invalid)?)
    }
    "connection.wsl.test": Admin Json |rt, _who| (distro: String) {
        json(wsl::wsl_connection_test(rt, distro).await.map_err(HostApiError::invalid)?)
    }

    "remote.state": Admin Json |rt, _who| () {
        json(remote::remote_host_state(rt).await.map_err(HostApiError::internal)?)
    }
    "remote.lanAddresses": Admin Json |rt, _who| () {
        json(remote::remote_lan_addresses(rt).await.map_err(HostApiError::internal)?)
    }
    "remote.enabled.set": Admin Json |rt, _who| (enabled: bool) {
        json(remote::remote_set_enabled(rt, enabled).await.map_err(HostApiError::invalid)?)
    }
    "remote.port.set": Admin Json |rt, _who| (port: u16) {
        json(remote::remote_set_port(rt, port).await.map_err(HostApiError::invalid)?)
    }
    "remote.addresses.set": Admin Json |rt, _who| (addresses: Vec<RemoteAccessAddress>, entry_address_id: String) {
        json(remote::remote_set_addresses(rt, addresses, entry_address_id).await.map_err(HostApiError::invalid)?)
    }
    "remote.pairing.regenerate": Admin Json |rt, _who| () {
        json(remote::remote_pairing_regenerate(rt).await.map_err(HostApiError::invalid)?)
    }
    "remote.device.revoke": Admin Json |rt, _who| (device_id: String) {
        json(remote::remote_device_revoke(rt, device_id).await.map_err(HostApiError::invalid)?)
    }
    "remote.device.rename": Admin Json |rt, _who| (device_id: String, name: String) {
        json(remote::remote_device_rename(rt, device_id, name).await.map_err(HostApiError::invalid)?)
    }

    "preferences.get": Chat Json |rt, _who| () {
        json(database(rt, preferences::preferences_get).await?)
    }
    "preferences.patch": Chat Json |rt, _who| (patch: Map<String, Value>, initial: Option<bool>) {
        json(database_input(rt, move |rt| preferences::preferences_patch(rt, patch, initial)).await?)
    }
    "theme.get": Chat Json |rt, _who| () {
        json(appearance::theme_settings_get(rt).await.map_err(HostApiError::internal)?)
    }
    "theme.set": Chat Json |rt, _who| (update: ThemeSettingsUpdate) {
        json(appearance::theme_settings_set(rt, update).await.map_err(HostApiError::invalid)?)
    }
    "models.get": Chat Json |rt, _who| (project_id: String) {
        json(database(rt, move |rt| project_api::project_model_cache_get(rt, &project_id)).await?)
    }
    "models.set": Chat Json |rt, who| (cache: ProjectModelCache) {
        let from_device = matches!(who, Principal::Device { .. });
        json(save_model_cache(rt, cache, from_device).await?)
    }
    "models.scope.get": Chat Json |rt, _who| (project_id: String) {
        json(database_input(rt, move |rt| project_api::project_model_scope_get(rt, project_id)).await?)
    }
    "models.scope.set": Chat Json |rt, _who| (project_id: String, models: Option<Vec<ProjectScopedModel>>) {
        json(database_input(rt, move |rt| project_api::project_model_scope_set(rt, project_id, models)).await?)
    }
    "nextPrompt.settings.get": Chat Json |rt, _who| (connection_id: String) {
        json(database_input(rt, move |rt| next_prompt::next_prompt_settings_get(rt, connection_id)).await?)
    }
    "nextPrompt.settings.set": Chat Json |rt, _who| (connection_id: String, enabled: bool, model: Option<NextPromptModel>) {
        json(database_input(rt, move |rt| next_prompt::next_prompt_settings_set(rt, connection_id, enabled, model)).await?)
    }
    "nextPrompt.request": Chat Json |rt, _who| (request: NextPromptRequest) {
        json(next_prompt::next_prompt_request(rt, request).await.map_err(HostApiError::invalid)?)
    }
    "promptEnhancement.settings.get": Chat Json |rt, _who| (connection_id: String) {
        json(database_input(rt, move |rt| prompt_enhancement::prompt_enhancement_settings_get(rt, connection_id)).await?)
    }
    "promptEnhancement.settings.set": Chat Json |rt, _who| (connection_id: String, enabled: bool, model: Option<PromptEnhancementModel>) {
        json(database_input(rt, move |rt| prompt_enhancement::prompt_enhancement_settings_set(rt, connection_id, enabled, model)).await?)
    }
    "promptEnhancement.enhance": Chat Json |rt, _who| (project_id: String, draft: String, model: Option<PromptEnhancementModel>) {
        json(prompt_enhancement::prompt_enhance(rt, project_id, draft, model).await.map_err(HostApiError::invalid)?)
    }
    "cacheKeepAlive.settings.list": Chat Json |rt, _who| (connection_id: String) {
        json(database_input(rt, move |rt| cache_keep_alive::cache_keep_alive_settings_list(rt, connection_id)).await?)
    }
    "cacheKeepAlive.settings.set": Chat Json |rt, _who| (settings: CacheKeepAliveSettings) {
        json(cache_keep_alive::cache_keep_alive_settings_set(rt, settings).await.map_err(HostApiError::invalid)?)
    }
    "cacheKeepAlive.pause": Chat Json |rt, _who| (session_key: String) {
        json(cache_keep_alive::cache_keep_alive_pause(rt, session_key).await.map_err(HostApiError::invalid)?)
    }

    "session.list": Chat Json |rt, who| (project_id: String, cached: Option<bool>, unwatched_only: Option<bool>) {
        if matches!(who, Principal::Device { .. }) {
            project::get(rt, &project_id).map_err(HostApiError::not_found)?;
        }
        let sessions = if cached.unwrap_or(false) {
            database(rt, move |rt| session_api::session_list(rt, project_id)).await?
        } else if unwatched_only.unwrap_or(false) {
            session_api::session_refresh_unwatched(rt, project_id).await.map_err(HostApiError::internal)?
        } else {
            session_api::session_reconcile(rt, project_id).await.map_err(HostApiError::internal)?.sessions
        };
        json(sessions)
    }
    "session.search": Chat Json |rt, _who| (project_id: String, query: String, limit: Option<usize>) {
        json(session_api::session_search(rt, project_id, query, limit).await.map_err(HostApiError::invalid)?)
    }
    "session.externalActivity": Chat Json |rt, _who| (project_id: String) {
        let project = session_api::session_runtime_project(rt, &project_id).map_err(HostApiError::not_found)?;
        json(rt.events.external_session_activity(rt, &project).await.map_err(HostApiError::internal)?)
    }
    "session.history": Chat Json |rt, _who| (
        project_id: String, session_path: String, expected_file_size: Option<u64>,
        expected_file_mtime_ns: Option<String>, start_message: Option<usize>,
        message_limit: Option<usize>, include_message_index: Option<bool>,
    ) {
        session_api::read_session_history(rt, project_id, session_path, expected_file_size,
            expected_file_mtime_ns, start_message, Some(message_limit.unwrap_or(256)),
            Some(include_message_index.unwrap_or(true))).await.map(Output::EncodedJson)
    }
    "session.historyImage": Chat BinaryOut |rt, _who| (
        project_id: String, session_path: String, image_id: String,
        expected_file_size: Option<u64>, expected_file_mtime_ns: Option<String>,
    ) {
        session_api::read_session_history_image(rt, project_id, session_path, image_id,
            expected_file_size, expected_file_mtime_ns).await.map(Output::Bytes)
    }
    "session.title": Chat Json |rt, _who| (project_id: String, message: String) {
        json(session_naming::session_generate_title(rt, project_id, message).await.map_err(HostApiError::invalid)?)
    }
    "session.delete": Chat Json |rt, _who| (project_id: String, session_path: String) {
        json(session_api::session_delete(rt, project_id, session_path).await.map_err(HostApiError::invalid)?)
    }
    "session.uiState.set": Chat Json |rt, _who| (project_id: Option<String>, session_path: String, update: SessionUiStateUpdate) {
        json(database_input(rt, move |rt| session_api::session_update_ui_state(rt, session_path, update, project_id)).await?)
    }
    "session.readStates": Chat Json |rt, _who| () {
        json(handle::session_read_states(rt).await.map_err(HostApiError::internal)?)
    }
    "session.markRead": Chat Json |rt, _who| (project_id: String, session_path: String, revision: u64) {
        json(handle::session_mark_read(rt, project_id, session_path, revision).await.map_err(HostApiError::invalid)?)
    }

    "chat.start": Chat Json |rt, who| (
        project_id: String, session_key: String, session_path: Option<String>,
        no_session: Option<bool>, builtin_extensions: Option<Vec<BuiltinExtension>>,
    ) {
        let request = ChatSessionRequest {
            project_id, session_key, session_path,
            no_session: no_session.unwrap_or(false),
            extensions: Vec::new(),
            builtin_extensions: builtin_extensions.unwrap_or_default(),
        };
        json(start_chat(rt, who, request).await?)
    }
    "chat.stop": Chat Json |rt, _who| (session_key: String, reason: Option<String>) {
        json(runtime_api::chat_session_stop(rt, session_key, reason).await.map_err(HostApiError::invalid)?)
    }
    "chat.state": Chat Json |rt, _who| (session_key: String) {
        json(runtime_api::chat_session_state(rt, session_key).await.map_err(HostApiError::internal)?)
    }
    "chat.transcript": Chat Json |rt, _who| (session_key: String, window: Option<TranscriptWindow>) {
        json(rt.chat_transcript_snapshot(&session_key, window.unwrap_or_default()).await.map_err(HostApiError::invalid)?)
    }
    "chat.rpc": Chat Json |rt, who| (session_key: String, command: Value) {
        validation::validate_rpc(who, &command).map_err(HostApiError::invalid)?;
        json(runtime_api::chat_session_send_rpc(rt, session_key, command).await.map_err(HostApiError::invalid)?)
    }
    "chat.mcp.approve": Workspace Json |rt, _who| (project_id: String, server_name: String) {
        json(runtime_api::project_mcp_server_approve(rt, project_id, server_name).await.map_err(HostApiError::invalid)?)
    }
    "files.search": Chat Json |rt, _who| (project_id: String, query: String) {
        let project = ready_project(rt, &project_id).await?;
        json(remote_fs::search(&rt.servers, &project, &query).await.map_err(HostApiError::internal)?)
    }
    "files.image": Chat BinaryOut |rt, _who| (project_id: String, path: String) {
        let project = ready_project(rt, &project_id).await?;
        remote_fs::read_image(&rt.servers, &project, &path).await
            .map(Output::Bytes).map_err(HostApiError::invalid)
    }
    "chat.files.upload": Chat BinaryIn(MAX_CHAT_FILE_BYTES) |rt, _who, data| (project_id: String, name: String) {
        let project = ready_project(rt, &project_id).await?;
        json(remote_fs::upload_chat_file(&rt.servers, &project, &name, data).await.map_err(HostApiError::invalid)?)
    }
    "chat.files.remove": Chat Json |rt, _who| (project_id: String, path: String) {
        let project = ready_project(rt, &project_id).await?;
        json(remote_fs::remove_chat_file(&rt.servers, &project, &path).await.map_err(HostApiError::invalid)?)
    }
}

async fn database<T: Send + 'static>(
    rt: &Runtime,
    operation: impl FnOnce(&Runtime) -> Result<T, String> + Send + 'static,
) -> Result<T, HostApiError> {
    let rt = rt.clone();
    blocking(move || operation(&rt).map_err(HostApiError::internal)).await
}

async fn database_input<T: Send + 'static>(
    rt: &Runtime,
    operation: impl FnOnce(&Runtime) -> Result<T, String> + Send + 'static,
) -> Result<T, HostApiError> {
    let rt = rt.clone();
    blocking(move || operation(&rt).map_err(HostApiError::invalid)).await
}

fn list_connections(rt: &Runtime) -> Result<Vec<Connection>, String> {
    let mut connections = vec![connections::local_connection_get(rt)?];
    let db = storage::open(&rt.paths)?;
    let saved = storage::list_connections(&db)?;
    connections.extend(
        saved
            .iter()
            .filter(|c| matches!(c.kind, pilo_domain::ConnectionKind::Wsl { .. }))
            .cloned(),
    );
    connections.extend(
        saved
            .into_iter()
            .filter(|c| matches!(c.kind, pilo_domain::ConnectionKind::Ssh { .. })),
    );
    Ok(connections)
}

async fn save_model_cache(
    rt: &Runtime,
    mut cache: ProjectModelCache,
    from_device: bool,
) -> Result<ProjectModelCache, HostApiError> {
    let rt = rt.clone();
    blocking(move || {
        // Keep v1's Host-owned timestamps and the native cache import semantics.
        if from_device {
            project::get(&rt, &cache.project_id).map_err(HostApiError::not_found)?;
            cache.refreshed_at_ms = storage::now_ms();
        }
        let db = storage::open(&rt.paths).map_err(HostApiError::internal)?;
        storage::upsert_project_model_cache(&db, &cache).map_err(HostApiError::internal)?;
        Ok(cache)
    })
    .await
}

async fn start_chat(
    rt: &Runtime,
    who: &Principal,
    request: ChatSessionRequest,
) -> Result<crate::session_snapshot::PiSessionSnapshot, HostApiError> {
    if matches!(who, Principal::Device { .. }) && !request.builtin_extensions.is_empty() {
        if !request.no_session
            || request.session_path.is_some()
            || request
                .builtin_extensions
                .iter()
                .any(|extension| !matches!(extension, BuiltinExtension::ModelCatalog))
        {
            return Err(HostApiError::invalid(
                "Remote catalog probes only support the model-catalog extension with noSession",
            ));
        }
        // A no-session probe does not send new_session or index an empty chat.
        return chat_service::prepare(&rt.paths, rt, rt.events.clone(), request)
            .await
            .map_err(HostApiError::invalid);
    }
    chat_service::start(&rt.paths, rt, rt.events.clone(), request)
        .await
        .map_err(HostApiError::invalid)
}

async fn ready_project(rt: &Runtime, id: &str) -> Result<pilo_domain::Project, HostApiError> {
    project::ready(rt, &rt.servers, id)
        .await
        .map_err(HostApiError::not_found)
}

fn validate_terminal_size(cols: u16, rows: u16) -> Result<(), HostApiError> {
    if cols == 0 || rows == 0 {
        return Err(HostApiError::invalid(
            "terminal size must be whole numbers from 1 to 65535",
        ));
    }
    Ok(())
}
