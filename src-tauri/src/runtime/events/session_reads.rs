use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use tokio::sync::Mutex;

use crate::{
    domain::{Project, SessionReadState},
    runtime::{host_paths::HostPaths, session_activity::SessionExternalActivity, storage},
};

#[cfg(feature = "tauri")]
use crate::runtime::{Runtime, pi_workspace, project, session_activity};

use super::{RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope};

pub(super) type ExternalReadActivity = Arc<StdMutex<HashMap<String, Arc<Mutex<HashSet<String>>>>>>;
/// Projects with a scheduled refresh worker and whether they need a rerun.
pub(super) type ExternalActivityRefreshes = Arc<StdMutex<HashMap<String, bool>>>;

/// Session file writes drive external activity refreshes. Polling only covers
/// open external turns (a crashed Pi writes nothing) and unwatched projects
/// on existing connections.
const EXTERNAL_ACTIVITY_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Spacing between event-driven reruns while an external turn keeps writing.
const EXTERNAL_ACTIVITY_RERUN_DELAY: Duration = Duration::from_secs(2);

struct SessionCompletion {
    project_id: String,
    session_path: String,
    completion_id: String,
}

#[derive(Default)]
pub(super) struct SessionCompletionQueue {
    worker_running: bool,
    pending: VecDeque<SessionCompletion>,
}

impl RuntimeEventBus {
    pub(crate) fn initialize_session_reads(&self, paths: HostPaths) {
        *self
            .session_read_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(paths);
    }

    fn session_read_paths(&self) -> Result<HostPaths, String> {
        self.session_read_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(|| "session read storage is not initialized".to_owned())
    }

    pub(crate) fn session_read_states(&self) -> Result<Vec<SessionReadState>, String> {
        storage::list_session_read_states(&storage::open_with_paths(&self.session_read_paths()?)?)
    }

    pub(crate) fn mark_session_read(
        &self,
        project_id: &str,
        session_path: &str,
        revision: u64,
    ) -> Result<SessionReadState, String> {
        if revision == 0 || revision > 9_007_199_254_740_991 {
            return Err("session read revision must be a positive safe integer".to_owned());
        }
        let state = storage::mark_session_read(
            &storage::open_with_paths(&self.session_read_paths()?)?,
            project_id,
            session_path,
            revision,
        )?;
        self.send(RuntimeEventEnvelope::global(
            RuntimeEvent::SessionReadStateChanged {
                state: state.clone(),
                completion_id: None,
            },
        ));
        Ok(state)
    }

    #[cfg(feature = "tauri")]
    pub(crate) async fn external_session_activity(
        &self,
        runtime: &Runtime,
        project: &Project,
    ) -> Result<Vec<SessionExternalActivity>, String> {
        self.update_external_session_activity(
            project,
            session_activity::external_session_activities_for_project(runtime, project, None),
        )
        .await
    }

    async fn update_external_session_activity(
        &self,
        project: &Project,
        probe: impl Future<Output = Result<Vec<SessionExternalActivity>, String>>,
    ) -> Result<Vec<SessionExternalActivity>, String> {
        let activity = self
            .external_read_activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(project.id.clone())
            .or_default()
            .clone();
        // Serialize snapshots and background probes per project so stale replies
        // cannot turn one external completion into multiple unread revisions.
        let mut previous = activity.lock().await;
        let result = probe.await;
        if let Ok(activities) = &result {
            for entry in activities {
                if !entry.turn_open && previous.contains(&entry.path) {
                    self.record_session_completion(project.id.clone(), entry.path.clone());
                }
            }
            // A disappeared process is not proof of a completed turn.
            let open_paths = activities
                .iter()
                .filter(|entry| entry.turn_open)
                .map(|entry| entry.path.clone())
                .collect::<HashSet<_>>();
            if open_paths != *previous {
                self.send(RuntimeEventEnvelope::global(
                    RuntimeEvent::ExternalSessionActivityChanged {
                        project_id: project.id.clone(),
                        activities: activities
                            .iter()
                            .filter(|entry| entry.turn_open)
                            .cloned()
                            .collect(),
                    },
                ));
            }
            *previous = open_paths;
        }
        if previous.is_empty() {
            let mut registry = self
                .external_read_activity
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Drop idle tracking once no overlapping poll holds this entry.
            if Arc::strong_count(&activity) == 2 {
                registry.remove(&project.id);
            }
        }
        result
    }

    #[cfg(feature = "tauri")]
    async fn refresh_cached_external_activity(
        &self,
        runtime: &Runtime,
        project_id: &str,
    ) -> Result<(), String> {
        if runtime.servers.is_shutting_down() {
            return Ok(());
        }
        let project = pi_workspace::resolve_session_project_with_paths(
            &runtime.paths,
            &project::get(runtime, project_id)?,
        )?;
        if project.default_workspace_pending() {
            return Ok(());
        }
        // A delayed watcher trigger must never connect or replace a live client.
        let Some(client) = runtime.servers.cached_client(&project.connection).await else {
            return Ok(());
        };
        self.update_external_session_activity(&project, async {
            let activities = session_activity::external_session_activities_for_project(
                runtime,
                &project,
                Some(&client),
            )
            .await?;
            if !runtime
                .servers
                .cached_client(&project.connection)
                .await
                .is_some_and(|current| Arc::ptr_eq(&current, &client))
            {
                return Err("pilo-server client changed during external activity probe".to_owned());
            }
            Ok(activities)
        })
        .await?;
        Ok(())
    }

    /// Refreshes one project's external activity off the caller's task. Triggers
    /// that arrive while a refresh runs collapse into one delayed rerun.
    #[cfg(feature = "tauri")]
    pub(crate) fn schedule_external_activity_refresh(&self, runtime: &Runtime, project_id: &str) {
        {
            let mut refreshes = self
                .external_activity_refreshes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(pending) = refreshes.get_mut(project_id) {
                *pending = true;
                return;
            }
            refreshes.insert(project_id.to_owned(), false);
        }
        let events = self.clone();
        let runtime = runtime.clone();
        let project_id = project_id.to_owned();
        crate::runtime::tasks::spawn(async move {
            loop {
                if let Err(error) = events
                    .refresh_cached_external_activity(&runtime, &project_id)
                    .await
                {
                    log::debug!(target: "session-reads", "external activity refresh failed: {error}");
                }
                let rerun = {
                    let mut refreshes = events
                        .external_activity_refreshes
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let rerun = refreshes.get(&project_id).copied().unwrap_or_default();
                    if !rerun {
                        refreshes.remove(&project_id);
                    }
                    rerun
                };
                if !rerun {
                    return;
                }
                tokio::time::sleep(EXTERNAL_ACTIVITY_RERUN_DELAY).await;
                if let Some(pending) = events
                    .external_activity_refreshes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get_mut(&project_id)
                {
                    *pending = false;
                }
            }
        });
    }

    /// Host-owned fallback for what session file events cannot report: an
    /// external Pi that exits mid-turn, a fallback-inferred turn going stale,
    /// and projects without a live session watcher.
    #[cfg(feature = "tauri")]
    pub(crate) fn start_external_activity_poll(&self, runtime: Runtime) {
        let events = self.clone();
        crate::runtime::tasks::spawn(async move {
            let mut tick = tokio::time::interval(EXTERNAL_ACTIVITY_POLL_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            loop {
                tick.tick().await;
                if runtime.servers.is_shutting_down() {
                    return;
                }
                let open_project_ids = events
                    .external_read_activity
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .keys()
                    .cloned()
                    .collect::<HashSet<_>>();
                let Ok(projects) = project::list(&runtime) else {
                    continue;
                };
                let mut projects = projects
                    .iter()
                    .filter_map(|project| {
                        pi_workspace::resolve_session_project_with_paths(&runtime.paths, project)
                            .ok()
                    })
                    .filter(|project| !project.default_workspace_pending())
                    .collect::<Vec<_>>();
                {
                    let watchers = runtime.session_watchers.lock().await;
                    projects.retain(|project| {
                        open_project_ids.contains(&project.id) || !watchers.covers(project)
                    });
                }
                for project in projects {
                    if runtime
                        .servers
                        .cached_client(&project.connection)
                        .await
                        .is_some()
                    {
                        events.schedule_external_activity_refresh(&runtime, &project.id);
                    }
                }
            }
        });
    }

    pub(crate) fn record_session_completion(&self, project_id: String, session_path: String) {
        let Ok(paths) = self.session_read_paths() else {
            return;
        };
        let mut id = [0_u8; 16];
        if let Err(error) = getrandom::fill(&mut id) {
            log::error!(target: "session-reads", "failed to identify session completion: {error}");
            return;
        }
        let completion_id = URL_SAFE_NO_PAD.encode(id);
        {
            let mut queue = self
                .session_completions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Publish the turn identity before SQLite work so clients can retain
            // that it was seen, even if they navigate away before commit.
            self.send(RuntimeEventEnvelope::global(
                RuntimeEvent::SessionTurnCompleted {
                    project_id: project_id.clone(),
                    session_path: session_path.clone(),
                    completion_id: completion_id.clone(),
                },
            ));
            let completion = SessionCompletion {
                project_id,
                session_path,
                completion_id,
            };
            // Read progress only needs the latest queued turn per session.
            if let Some(pending) = queue.pending.iter_mut().find(|pending| {
                pending.project_id == completion.project_id
                    && pending.session_path == completion.session_path
            }) {
                *pending = completion;
            } else {
                queue.pending.push_back(completion);
            }
            if queue.worker_running {
                return;
            }
            queue.worker_running = true;
        }
        let events = self.clone();
        // One worker preserves each session's turn order without blocking Pi.
        crate::runtime::tasks::spawn_blocking(move || {
            loop {
                let completion = {
                    let mut queue = events
                        .session_completions
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    match queue.pending.pop_front() {
                        Some(completion) => completion,
                        None => {
                            queue.worker_running = false;
                            return;
                        }
                    }
                };
                match storage::open_with_paths(&paths).and_then(|db| {
                    storage::complete_session_turn(
                        &db,
                        &completion.project_id,
                        &completion.session_path,
                    )
                }) {
                    Ok(state) => events.send(RuntimeEventEnvelope::global(
                        RuntimeEvent::SessionReadStateChanged {
                            state,
                            completion_id: Some(completion.completion_id),
                        },
                    )),
                    Err(error) => {
                        log::error!(target: "session-reads", "failed to record session completion: {error}");
                    }
                }
            }
        });
    }
}
