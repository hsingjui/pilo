use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};

use pilo_domain::Project;

use super::{connection_diagnostics::request_failure_reason, host_events::HostEvents};

use super::{
    Runtime,
    events::{PiProcessState, RuntimeEvent, RuntimeEventEnvelope},
    pi_workspace, project,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient},
    session_api,
    session_index::{self, SessionScanClient},
};

pub const SESSION_WATCH_EVENT_NAME: &str = "pilo://sessions";
const WATCH_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SessionWatchEvent {
    Changed {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Indexed {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Backend {
        #[serde(rename = "projectId")]
        project_id: String,
        backend: String,
    },
    Error {
        #[serde(rename = "projectId")]
        project_id: String,
        message: String,
    },
}

struct WatchHandle {
    project: Project,
    live: Arc<AtomicBool>,
    current_client: Arc<AsyncMutex<Arc<ServerClient>>>,
    stream_id: String,
    task: JoinHandle<()>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct SessionWatcherManager {
    watchers: HashMap<String, WatchHandle>,
}

impl SessionWatcherManager {
    /// Starts the project's watcher unless a live one covers it. The registry
    /// lock is held only to read and change the map, never across a pilo-server
    /// request, so a slow connection cannot stall other projects. Callers hold
    /// the project's session index lock, which orders starts and stops of one
    /// project.
    pub async fn start(
        watchers: &AsyncMutex<Self>,
        runtime: &Runtime,
        project: &Project,
        session_project: Project,
        client: Arc<ServerClient>,
    ) -> Result<(), String> {
        let previous = {
            let mut registry = watchers.lock().await;
            if registry.covers(&session_project) || runtime.servers.is_shutting_down() {
                return Ok(());
            }
            registry.watchers.remove(&project.id)
        };
        if let Some(previous) = previous {
            stop_handle(&project.id, previous).await;
        }
        let started = Instant::now();
        let stream_id = format!("session-watch:{}", project.id);
        let mut events = client.subscribe(&stream_id);
        tokio::time::timeout(
            WATCH_REQUEST_TIMEOUT,
            client.request(
                "session.watch_start",
                json!({ "streamId": stream_id, "project": session_project.path }),
            ),
        )
        .await
        .unwrap_or_else(|_| Err("pilo-server request 'session.watch_start' timed out".to_owned()))
        .inspect_err(|error| log_start_failure(&project.id, "watch_start", started, error))?;
        // Project and stream IDs embed the workspace path; log only a digest.
        let project_hash = format!("{:x}", Sha256::digest(project.id.as_bytes()));
        log::info!(target: "session-watcher", "started projectHash={project_hash} connectionId={:?} elapsedMs={}", session_project.connection.id, started.elapsed().as_millis());
        let current_client = Arc::new(AsyncMutex::new(Arc::clone(&client)));
        let event_stream_id = stream_id.clone();
        let project_id = project.id.clone();
        let project_path = session_project.path.clone();
        let connection = session_project.connection.clone();
        let watched_project = session_project.clone();
        let live = Arc::new(AtomicBool::new(true));
        let event_live = Arc::clone(&live);
        let host_events = runtime.host_events.clone();
        let mut event_runtime = runtime.downgrade();
        let event_servers = Arc::clone(&runtime.servers);
        let event_client = Arc::clone(&current_client);
        let task = tokio::spawn(async move {
            let mut client = client;
            let mut notices = WatchEvents {
                events: host_events,
                project_id: project_id.clone(),
                project_hash: project_hash.clone(),
                errors: RepeatedFailureLog::default(),
                delivery: RepeatedFailureLog::default(),
            };
            loop {
                let event = tokio::select! {
                    _ = event_runtime.closed() => return,
                    event = events.recv() => event,
                };
                let disconnect_message = match event {
                    Some(event) if event.event == SERVER_DISCONNECTED_EVENT => event
                        .data
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("pilo-server session watcher disconnected")
                        .to_owned(),
                    Some(event) => {
                        let Ok(event_runtime) = event_runtime.upgrade() else {
                            return;
                        };
                        if event.stream_id != event_stream_id {
                            continue;
                        }
                        match event.event.as_str() {
                            "session.changed" => {
                                let paths = string_array(&event.data, "paths");
                                let removed_paths = string_array(&event.data, "removedPaths");
                                let full_refresh = event
                                    .data
                                    .get("full")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(paths.is_empty() && removed_paths.is_empty());
                                refresh_external_activity(
                                    &event_runtime,
                                    &project_id,
                                    full_refresh,
                                    &paths,
                                    &removed_paths,
                                )
                                .await;
                                notices
                                    .refresh_index(
                                        &event_runtime,
                                        &watched_project,
                                        &client,
                                        full_refresh,
                                        &paths,
                                        &removed_paths,
                                    )
                                    .await;
                            }
                            "session.backend" => notices.backend(
                                event
                                    .data
                                    .get("backend")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("server"),
                            ),
                            "session.error" => {
                                // The failed notification may have been the only write.
                                event_live.store(false, Ordering::Relaxed);
                                notices.error(
                                    "backend",
                                    event
                                        .data
                                        .get("message")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("pilo-server session watcher failed"),
                                );
                                event_runtime.events.schedule_external_activity_refresh(
                                    &event_runtime,
                                    &project_id,
                                );
                                notices
                                    .refresh_index(
                                        &event_runtime,
                                        &watched_project,
                                        &client,
                                        true,
                                        &[],
                                        &[],
                                    )
                                    .await;
                            }
                            _ => {}
                        }
                        continue;
                    }
                    None => "pilo-server session watcher event channel closed".to_owned(),
                };

                event_live.store(false, Ordering::Relaxed);
                notices.error(
                    "disconnected",
                    format!("{disconnect_message}; reconnecting session watcher"),
                );
                let reconnect_started = Instant::now();
                let mut attempts = 0_u64;
                let mut retry_log = RepeatedFailureLog::default();
                let mut delay = Duration::from_millis(250);
                loop {
                    tokio::select! {
                        _ = event_runtime.closed() => return,
                        _ = tokio::time::sleep(delay) => {}
                    }
                    if event_servers.is_shutting_down() {
                        return;
                    }
                    attempts = attempts.saturating_add(1);
                    let next_client =
                        if matches!(connection.kind, pilo_domain::ConnectionKind::Ssh { .. }) {
                            match event_servers.recover_ssh_client(&connection).await {
                                Ok(Some(client)) => Ok(client),
                                Ok(None) => return,
                                Err(error) => Err(error),
                            }
                        } else {
                            event_servers.client(&connection).await
                        };
                    let (stage, error) = match next_client {
                        Ok(next_client) => {
                            let next_events = next_client.subscribe(&event_stream_id);
                            *event_client.lock().await = Arc::clone(&next_client);
                            match next_client
                                .request(
                                    "session.watch_start",
                                    json!({
                                        "streamId": event_stream_id,
                                        "project": project_path,
                                    }),
                                )
                                .await
                            {
                                Ok(_) => {
                                    events = next_events;
                                    client = next_client;
                                    event_live.store(true, Ordering::Relaxed);
                                    let suppressed = retry_log.recover().unwrap_or(0);
                                    let suppressed_errors = notices.errors.recover().unwrap_or(0);
                                    log::info!(target: "session-watcher", "recovered projectHash={project_hash} connectionId={:?} attempts={attempts} elapsedMs={} suppressedFailures={suppressed} suppressedErrors={suppressed_errors}", connection.id, reconnect_started.elapsed().as_millis());
                                    // Turns and session files may have changed while disconnected.
                                    let Ok(event_runtime) = event_runtime.upgrade() else {
                                        return;
                                    };
                                    event_runtime.events.schedule_external_activity_refresh(
                                        &event_runtime,
                                        &project_id,
                                    );
                                    notices
                                        .refresh_index(
                                            &event_runtime,
                                            &watched_project,
                                            &client,
                                            true,
                                            &[],
                                            &[],
                                        )
                                        .await;
                                    break;
                                }
                                Err(error) => ("watch_start", error),
                            }
                        }
                        Err(error) => ("connect", error),
                    };
                    if let Some(reason) = request_failure_reason("session.watch_start", &error)
                        && let Some(suppressed) = retry_log.failure()
                    {
                        log::warn!(target: "session-watcher", "reconnect failed projectHash={project_hash} connectionId={:?} stage={stage} attempts={attempts} elapsedMs={} attemptDelayMs={} suppressedFailures={suppressed} reason={reason}", connection.id, reconnect_started.elapsed().as_millis(), delay.as_millis());
                    }
                    delay = delay.saturating_mul(2).min(Duration::from_secs(10));
                }
            }
        });
        let handle = WatchHandle {
            project: session_project,
            live,
            current_client,
            stream_id,
            task,
        };
        let mut registry = watchers.lock().await;
        // Shutdown drains the registry; a watcher started meanwhile must not outlive it.
        if runtime.servers.is_shutting_down() {
            drop(registry);
            stop_handle(&project.id, handle).await;
            return Ok(());
        }
        // The index lock keeps another start of this project out, so nothing
        // is replaced here; a stray handle would only be aborted on drop.
        registry.watchers.insert(project.id.clone(), handle);
        drop(registry);
        // Seed activity for external turns that started before registration.
        runtime
            .events
            .schedule_external_activity_refresh(runtime, &project.id);
        Ok(())
    }

    pub async fn stop(watchers: &AsyncMutex<Self>, project_id: &str) -> bool {
        let Some(handle) = watchers.lock().await.watchers.remove(project_id) else {
            return false;
        };
        stop_handle(project_id, handle).await;
        true
    }

    pub async fn stop_all(watchers: &AsyncMutex<Self>) {
        let handles = watchers.lock().await.watchers.drain().collect::<Vec<_>>();
        for (id, handle) in handles {
            stop_handle(&id, handle).await;
        }
    }

    pub(crate) fn covers(&self, project: &Project) -> bool {
        self.watchers.get(&project.id).is_some_and(|watcher| {
            !watcher.task.is_finished()
                && watcher.live.load(Ordering::Relaxed)
                && same_session_scope(&watcher.project, project)
        })
    }
}

/// Aborts a removed watcher and asks pilo-server to stop its stream, outside
/// the registry lock.
async fn stop_handle(project_id: &str, handle: WatchHandle) {
    handle.task.abort();
    let client = handle.current_client.lock().await.clone();
    let result = tokio::time::timeout(
        WATCH_REQUEST_TIMEOUT,
        client.request(
            "session.watch_stop",
            json!({ "streamId": handle.stream_id }),
        ),
    )
    .await;
    log::info!(target: "session-watcher", "stopped projectHash={:x} remoteStopOk={}", Sha256::digest(project_id.as_bytes()), matches!(result, Ok(Ok(_))));
}

fn same_session_scope(a: &Project, b: &Project) -> bool {
    a.connection.id == b.connection.id && a.connection.kind == b.connection.kind && a.path == b.path
}

/// External Pi turns start and end with session file writes, so file changes
/// drive external activity refreshes. Pilo's own running sessions write on
/// every message; changes limited to those paths cannot reveal an external
/// turn and are skipped.
async fn refresh_external_activity(
    runtime: &Runtime,
    project_id: &str,
    full_refresh: bool,
    paths: &[String],
    removed_paths: &[String],
) {
    if !full_refresh && removed_paths.is_empty() {
        let owned_paths = runtime
            .chat_sessions
            .states()
            .await
            .into_iter()
            .filter(|state| state.project_id == project_id)
            .filter(|state| {
                matches!(
                    state.snapshot.state,
                    PiProcessState::Running | PiProcessState::Starting
                )
            })
            .filter_map(|state| state.session_path)
            .collect::<HashSet<_>>();
        if paths.iter().all(|path| owned_paths.contains(path)) {
            return;
        }
    }
    runtime
        .events
        .schedule_external_activity_refresh(runtime, project_id);
}

fn string_array(data: &Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn log_start_failure(project_id: &str, stage: &str, started: Instant, error: &str) {
    if let Some(reason) = request_failure_reason("session.watch_start", error) {
        log::warn!(target: "session-watcher", "start failed projectHash={:x} stage={stage} elapsedMs={} reason={reason}", Sha256::digest(project_id.as_bytes()), started.elapsed().as_millis());
    }
}

#[derive(Default)]
struct RepeatedFailureLog {
    last_logged: Option<Instant>,
    suppressed: u64,
}

impl RepeatedFailureLog {
    fn failure(&mut self) -> Option<u64> {
        if self
            .last_logged
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(60))
        {
            self.last_logged = Some(Instant::now());
            return Some(std::mem::take(&mut self.suppressed));
        }
        self.suppressed = self.suppressed.saturating_add(1);
        None
    }

    fn recover(&mut self) -> Option<u64> {
        self.last_logged
            .take()
            .map(|_| std::mem::take(&mut self.suppressed))
    }
}

struct WatchEvents {
    events: Arc<dyn HostEvents>,
    project_id: String,
    project_hash: String,
    errors: RepeatedFailureLog,
    delivery: RepeatedFailureLog,
}

impl WatchEvents {
    async fn refresh_index(
        &mut self,
        runtime: &Runtime,
        watched_project: &Project,
        client: &ServerClient,
        full_refresh: bool,
        paths: &[String],
        removed_paths: &[String],
    ) {
        let _scan = session_api::lock_session_index(runtime, &self.project_id).await;
        if runtime.servers.is_shutting_down() {
            return;
        }
        let Ok(project) = project::get(runtime, &self.project_id) else {
            return;
        };
        let Ok(session_project) =
            pi_workspace::resolve_session_project_with_paths(&runtime.paths, &project)
        else {
            return;
        };
        if !same_session_scope(watched_project, &session_project) {
            return;
        }
        let client = SessionScanClient::Existing(client);
        if !full_refresh {
            match session_index::reconcile_paths(
                &runtime.paths,
                client,
                &project,
                paths,
                removed_paths,
            )
            .await
            {
                Ok(0) => return,
                Ok(_) => {
                    self.publish_indexed(runtime);
                    return;
                }
                Err(error) => self.error(
                    "index",
                    format!("targeted session indexing failed: {error}"),
                ),
            }
        }
        self.changed();
        match session_api::reconcile_project_sessions(runtime, &project, client).await {
            Ok(_) => self.publish_indexed(runtime),
            Err(error) => self.error("index", format!("session reconciliation failed: {error}")),
        }
    }

    fn publish_indexed(&mut self, runtime: &Runtime) {
        self.indexed();
        runtime.events.send(RuntimeEventEnvelope::global(
            RuntimeEvent::SessionsIndexed {
                project_id: self.project_id.clone(),
            },
        ));
    }

    fn emit(&mut self, event: SessionWatchEvent) {
        let kind = match &event {
            SessionWatchEvent::Changed { .. } => "changed",
            SessionWatchEvent::Indexed { .. } => "indexed",
            SessionWatchEvent::Backend { .. } => "backend",
            SessionWatchEvent::Error { .. } => "error",
        };
        if self
            .events
            .emit_serialized(SESSION_WATCH_EVENT_NAME, event)
            .is_err()
        {
            if let Some(suppressed) = self.delivery.failure() {
                log::warn!(target: "session-watcher", "event emission failed projectHash={} event={kind} suppressedFailures={suppressed} reason=emit_failed", self.project_hash);
            }
        } else if let Some(suppressed) = self.delivery.recover() {
            log::info!(target: "session-watcher", "event emission resumed projectHash={} event={kind} suppressedFailures={suppressed}", self.project_hash);
        }
    }

    fn changed(&mut self) {
        self.emit(SessionWatchEvent::Changed {
            project_id: self.project_id.clone(),
        });
    }

    fn indexed(&mut self) {
        self.emit(SessionWatchEvent::Indexed {
            project_id: self.project_id.clone(),
        });
    }

    fn backend(&mut self, backend: &str) {
        self.emit(SessionWatchEvent::Backend {
            project_id: self.project_id.clone(),
            backend: backend.to_owned(),
        });
    }

    fn error(&mut self, stage: &'static str, message: impl Into<String>) {
        let message = message.into();
        if let Some(reason) = request_failure_reason("session.watch", &message) {
            let summary = if stage == "disconnected" {
                Some(self.errors.recover().unwrap_or(0))
            } else {
                self.errors.failure()
            };
            if let Some(suppressed) = summary {
                log::warn!(target: "session-watcher", "watch error projectHash={} stage={stage} suppressedFailures={suppressed} reason={reason}", self.project_hash);
            }
        }
        self.emit(SessionWatchEvent::Error {
            project_id: self.project_id.clone(),
            message,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{Duration, Instant, RepeatedFailureLog};

    #[test]
    fn watcher_emits_named_payloads_and_recovers_after_delivery_failure() {
        let events = std::sync::Arc::new(crate::host_events::RecordingEvents::default());
        let mut watcher = super::WatchEvents {
            events: events.clone(),
            project_id: "project-1".to_owned(),
            project_hash: "hash".to_owned(),
            errors: RepeatedFailureLog::default(),
            delivery: RepeatedFailureLog::default(),
        };
        watcher.changed();
        watcher.indexed();
        watcher.backend("");
        watcher.error("index", "failed");
        let recorded = events.events.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![
                (
                    super::SESSION_WATCH_EVENT_NAME.to_owned(),
                    serde_json::json!({"type":"changed", "projectId":"project-1"})
                ),
                (
                    super::SESSION_WATCH_EVENT_NAME.to_owned(),
                    serde_json::json!({"type":"indexed", "projectId":"project-1"})
                ),
                (
                    super::SESSION_WATCH_EVENT_NAME.to_owned(),
                    serde_json::json!({"type":"backend", "projectId":"project-1", "backend":""})
                ),
                (
                    super::SESSION_WATCH_EVENT_NAME.to_owned(),
                    serde_json::json!({"type":"error", "projectId":"project-1", "message":"failed"})
                ),
            ]
        );
        events
            .fail
            .store(true, std::sync::atomic::Ordering::Relaxed);
        watcher.changed();
        assert!(watcher.delivery.last_logged.is_some());
        events
            .fail
            .store(false, std::sync::atomic::Ordering::Relaxed);
        watcher.changed();
        assert!(watcher.delivery.last_logged.is_none());
        assert_eq!(events.events.lock().unwrap().len(), 5);
    }

    #[test]
    fn repeated_failures_log_once_and_count_suppressed_records() {
        let mut log = RepeatedFailureLog::default();
        assert_eq!(log.failure(), Some(0));
        let first_logged = log.last_logged;
        assert_eq!(log.failure(), None);
        assert_eq!(log.failure(), None);
        assert_eq!(log.last_logged, first_logged);
        assert_eq!(log.suppressed, 2);
    }

    #[test]
    fn periodic_summary_reports_and_resets_the_suppressed_count() {
        let mut log = RepeatedFailureLog::default();
        assert_eq!(log.failure(), Some(0));
        assert_eq!(log.failure(), None);
        assert_eq!(log.failure(), None);

        // Advance the window without sleeping or changing the production clock.
        log.last_logged = Some(Instant::now() - Duration::from_secs(60));
        assert_eq!(log.failure(), Some(2));
        assert_eq!(log.suppressed, 0);
        assert_eq!(log.failure(), None);
        assert_eq!(log.recover(), Some(1));
    }

    #[test]
    fn recovery_reports_suppression_once_and_starts_a_new_window() {
        let mut log = RepeatedFailureLog::default();
        assert_eq!(log.recover(), None);
        assert_eq!(log.failure(), Some(0));
        assert_eq!(log.failure(), None);
        assert_eq!(log.recover(), Some(1));
        assert_eq!(log.last_logged, None);
        assert_eq!(log.suppressed, 0);
        assert_eq!(log.recover(), None);

        assert_eq!(log.failure(), Some(0));
        assert_eq!(log.recover(), Some(0));
    }
}
