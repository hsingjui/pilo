use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::domain::Project;

use super::{
    super::{
        debug_trace::runtime_trace,
        events::{PiProcessState, RuntimeEventBus},
        server_client::ServerManager,
        server_pi::{PiLaunchOptions, ServerPiSession},
        session_snapshot::PiSessionSnapshot,
    },
    ChatProcess, ChatSessionLaunch, ChatSessions,
    event_sink::ChatEventSink,
};

impl ChatSessions {
    async fn spawn_if_needed(
        process: &Arc<ChatProcess>,
        session: &mut ServerPiSession,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: &Project,
        session_key: &str,
    ) -> Result<PiSessionSnapshot, String> {
        let snapshot = session.snapshot();
        if snapshot.state == PiProcessState::Running {
            return Ok(snapshot);
        }
        process.prepared.store(false, Ordering::Release);
        process.initialized.store(false, Ordering::Release);
        *process
            .control_reply
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        let session_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        runtime_trace(
            "chat.spawn.begin",
            Some(session_key),
            None,
            json!({
                "projectId": project.id,
                "hasSessionPath": session_path.is_some(),
                "noSession": process.no_session,
            }),
        );
        let result = session
            .spawn(
                servers,
                ChatEventSink {
                    events: app.state::<RuntimeEventBus>().inner().clone(),
                    session_key: session_key.to_owned(),
                    project_id: project.id.clone(),
                    control_reply: Arc::clone(&process.control_reply),
                    session_path: Arc::clone(&process.session_path),
                    active_turn: Arc::clone(&process.active_turn),
                    closed: Arc::clone(&process.closed),
                },
                project,
                PiLaunchOptions {
                    session_path,
                    no_session: process.no_session,
                    extensions: process.extensions.clone(),
                    disable_builtin_tools: process.disable_builtin_tools,
                    disable_extension_discovery: process.disable_extension_discovery,
                    disable_context_files: process.disable_context_files,
                    ..PiLaunchOptions::default()
                },
            )
            .await;
        match &result {
            Ok(snapshot) => runtime_trace(
                "chat.spawn.end",
                Some(session_key),
                session.stream_id(),
                json!({
                    "ok": true,
                    "generation": snapshot.generation,
                    "state": snapshot.state,
                }),
            ),
            Err(error) => runtime_trace(
                "chat.spawn.end",
                Some(session_key),
                session.stream_id(),
                json!({ "ok": false, "error": error }),
            ),
        }
        result
    }

    async fn wait_for_control_response(
        process: &Arc<ChatProcess>,
        session: &ServerPiSession,
        command: Value,
    ) -> Result<(), String> {
        let (sender, response) = oneshot::channel();
        *process
            .control_reply
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(sender);
        let result = async {
            session.send_rpc(command).await?;
            tokio::time::timeout(Duration::from_secs(30), response)
                .await
                .map_err(|_| "Pi session initialization timed out".to_owned())?
                .map_err(|_| "Pi session initialization channel closed".to_owned())?
        }
        .await;
        if result.is_err() {
            *process
                .control_reply
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
        }
        result
    }

    pub async fn prepare(
        &self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: Project,
        session_key: String,
        launch: ChatSessionLaunch,
    ) -> Result<PiSessionSnapshot, String> {
        runtime_trace(
            "chat.prepare.begin",
            Some(&session_key),
            None,
            json!({
                "hasSessionPath": launch.session_path.is_some(),
                "noSession": launch.no_session,
            }),
        );
        let process = self.process(&project, &session_key, &launch).await?;
        let mut session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("project is closing".to_owned());
        }
        let snapshot =
            Self::spawn_if_needed(&process, &mut session, servers, app, &project, &session_key)
                .await?;
        if process.prepared.load(Ordering::Acquire) {
            runtime_trace(
                "chat.prepare.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": true, "cached": true, "generation": snapshot.generation }),
            );
            return Ok(snapshot);
        }
        let prepared = Self::wait_for_control_response(
            &process,
            &session,
            serde_json::json!({ "id": "pilo-session-prepare", "type": "get_state" }),
        )
        .await;
        if let Err(error) = prepared {
            runtime_trace(
                "chat.prepare.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": false, "error": error }),
            );
            process.prepared.store(false, Ordering::Release);
            process.initialized.store(false, Ordering::Release);
            let _ = session.stop().await;
            return Err(error);
        }
        process.prepared.store(true, Ordering::Release);
        if launch.session_path.is_some() || process.no_session {
            // Pi was launched with --session, so the readiness get_state also proves
            // the requested historical session is fully loaded. --no-session starts
            // with an in-memory session that needs no additional new_session RPC.
            process.initialized.store(true, Ordering::Release);
        }
        let snapshot = session.snapshot();
        runtime_trace(
            "chat.prepare.end",
            Some(&session_key),
            session.stream_id(),
            json!({ "ok": true, "cached": false, "generation": snapshot.generation }),
        );
        Ok(snapshot)
    }

    pub async fn ensure(
        &self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: Project,
        session_key: String,
        launch: ChatSessionLaunch,
    ) -> Result<PiSessionSnapshot, String> {
        runtime_trace(
            "chat.ensure.begin",
            Some(&session_key),
            None,
            json!({
                "hasSessionPath": launch.session_path.is_some(),
                "noSession": launch.no_session,
            }),
        );
        let process = self.process(&project, &session_key, &launch).await?;
        let mut session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("project is closing".to_owned());
        }
        let snapshot =
            Self::spawn_if_needed(&process, &mut session, servers, app, &project, &session_key)
                .await?;
        if process.initialized.load(Ordering::Acquire) {
            runtime_trace(
                "chat.ensure.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": true, "cached": true, "generation": snapshot.generation }),
            );
            return Ok(snapshot);
        }
        let resume_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let command = if launch.session_path.is_some() {
            serde_json::json!({ "id": "pilo-session-init", "type": "get_state" })
        } else {
            match resume_path {
                Some(path) => {
                    serde_json::json!({ "id": "pilo-session-init", "type": "switch_session", "sessionPath": path })
                }
                None => serde_json::json!({ "id": "pilo-session-init", "type": "new_session" }),
            }
        };
        let initialized = Self::wait_for_control_response(&process, &session, command).await;
        if let Err(error) = initialized {
            runtime_trace(
                "chat.ensure.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": false, "error": error }),
            );
            process.prepared.store(false, Ordering::Release);
            process.initialized.store(false, Ordering::Release);
            let _ = session.stop().await;
            return Err(error);
        }
        process.prepared.store(true, Ordering::Release);
        process.initialized.store(true, Ordering::Release);
        let snapshot = session.snapshot();
        runtime_trace(
            "chat.ensure.end",
            Some(&session_key),
            session.stream_id(),
            json!({ "ok": true, "cached": false, "generation": snapshot.generation }),
        );
        Ok(snapshot)
    }
}
