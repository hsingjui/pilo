use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use serde_json::{Value, json};

use crate::domain::{ConnectionKind, Project};

use super::{
    super::{
        debug_trace::runtime_trace,
        events::{PiProcessState, RuntimeEvent, RuntimeEventEnvelope},
    },
    ChatProcess, ChatSessions,
};

static PROMPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl ChatSessions {
    pub(crate) async fn configure_cache_keep_alive(
        &self,
        session_key: &str,
        settings: Value,
    ) -> Result<(), String> {
        let Some(process) = self
            .registry
            .lock()
            .await
            .processes
            .get(session_key)
            .cloned()
        else {
            return Ok(());
        };
        let session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire)
            || !session.cache_keep_alive_ready()
            || !session
                .builtin_extensions()
                .contains(&pilo_protocol::BuiltinExtension::CacheKeepAlive)
        {
            return Ok(());
        }
        // A registered extension command, never an Agent prompt or an idle-cache touch.
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            session.send_rpc(json!({
                "id": "pilo-cache-keep-alive-config",
                "type": "prompt",
                "message": format!("/pilo-cache-keep-alive {settings}"),
            })),
        )
        .await
        .map_err(|_| "cache keep-alive configuration timed out".to_owned())?
    }

    async fn close_process(&self, session_key: &str) -> Option<Arc<ChatProcess>> {
        let (process, events) = {
            let mut registry = self.registry.lock().await;
            let process = registry.processes.remove(session_key)?;
            registry.snapshots.remove(session_key);
            registry.idle_since.remove(session_key);
            process.mark_closed();
            (process, registry.events.clone())
        };
        if let Some(events) = events {
            let process = Arc::clone(&process);
            let registry = Arc::clone(&self.registry);
            let session_key = session_key.to_owned();
            // Detach must not wait for a session lock held by startup or RPC work.
            tokio::spawn(async move {
                let snapshot = process.session.lock().await.snapshot();
                let registry = registry.lock().await;
                // Do not send an old stop event to a runtime already replacing this one.
                if !registry.processes.contains_key(&session_key) {
                    events.send(RuntimeEventEnvelope::session(
                        session_key,
                        process.project_id.clone(),
                        RuntimeEvent::ProcessState {
                            generation: snapshot.generation,
                            state: PiProcessState::Stopped,
                        },
                    ));
                }
            });
        }
        Some(process)
    }

    pub(crate) async fn send_input_assistance(
        &self,
        session_key: &str,
        project_id: &str,
        generation: u64,
        cancel: bool,
        command: Value,
    ) -> Result<(), String> {
        let process = self
            .registry
            .lock()
            .await
            .processes
            .get(session_key)
            .cloned()
            .ok_or_else(|| "prediction session is not running".to_owned())?;
        let session = process.session.lock().await;
        let snapshot = session.snapshot();
        if process.closed.load(Ordering::Acquire)
            || process.project_id != project_id
            || snapshot.generation != generation
            || snapshot.state != PiProcessState::Running
            || !process.initialized.load(Ordering::Acquire)
            || !session.next_prompt_ready()
            || !session
                .builtin_extensions()
                .contains(&pilo_protocol::BuiltinExtension::NextPrompt)
            || (!cancel
                && (process.active_turn.load(Ordering::Acquire)
                    || process.compacting.load(Ordering::Acquire)))
        {
            runtime_trace(
                "next_prompt.reject",
                Some(session_key),
                session.stream_id(),
                json!({
                    "reason": "process_unavailable",
                    "id": command.get("id"),
                    "generation": snapshot.generation,
                    "expectedGeneration": generation,
                    "state": snapshot.state,
                    "initialized": process.initialized.load(Ordering::Acquire),
                    "ready": session.next_prompt_ready(),
                    "activeTurn": process.active_turn.load(Ordering::Acquire),
                    "compacting": process.compacting.load(Ordering::Acquire),
                    "cancel": cancel,
                }),
            );
            return Err("prediction session is no longer idle or available".to_owned());
        }
        // This registered extension command is not an Agent turn or an idle-cache touch.
        tokio::time::timeout(std::time::Duration::from_secs(2), session.send_rpc(command))
            .await
            .map_err(|_| "prediction transport timed out".to_owned())?
    }

    pub async fn send(&self, session_key: &str, mut command: Value) -> Result<(), String> {
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        // Pi may resume autonomously before either UI observes its new turn.
        if command_type == "prompt"
            && let Some(command) = command.as_object_mut()
        {
            command
                .entry("streamingBehavior")
                .or_insert_with(|| Value::String("followUp".to_owned()));
        }
        // Generate an id for callers that send none, so Pi's prompt response can
        // release the preemptive active-turn flag after a preflight rejection.
        if command_type == "prompt"
            && command.is_object()
            && command.get("id").and_then(Value::as_str).is_none()
        {
            command["id"] = Value::String(format!(
                "pilo-prompt-{}",
                PROMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
        }
        let command_id = command.get("id").and_then(Value::as_str).map(str::to_owned);
        let process = {
            let mut registry = self.registry.lock().await;
            registry.usage_sequence = registry.usage_sequence.saturating_add(1);
            let process = registry
                .processes
                .get(session_key)
                .cloned()
                .ok_or_else(|| format!("session '{session_key}' is not running"))?;
            // Read-only polling must not keep an otherwise idle Pi warm forever.
            if !command_type.starts_with("get_") {
                process
                    .last_used
                    .store(registry.usage_sequence, Ordering::Release);
            }
            process
        };
        let started = Instant::now();
        runtime_trace(
            "chat.send.wait_lock",
            Some(session_key),
            None,
            json!({ "command": command_type, "id": command_id }),
        );
        let session = process.session.lock().await;
        let lock_wait_ms = started.elapsed().as_millis();
        if process.closed.load(Ordering::Acquire) {
            return Err("project is closing".to_owned());
        }
        runtime_trace(
            "chat.send.begin",
            Some(session_key),
            session.stream_id(),
            json!({ "command": command_type, "id": command_id, "lockWaitMs": lock_wait_ms }),
        );
        // Protect the gap between accepting a prompt and its first Pi event.
        let work_flag = match command_type.as_str() {
            "prompt" => Some(&process.active_turn),
            "compact" => Some(&process.compacting),
            _ => None,
        };
        let was_active = work_flag.is_some_and(|flag| flag.swap(true, Ordering::AcqRel));
        // Only the prompt that flipped an idle flag owns it. A rejected prompt must
        // not clear a turn that was already running when it was sent.
        let mut owns_prompt_flag = false;
        if command_type == "prompt"
            && !was_active
            && let Some(id) = command_id.clone()
        {
            *process
                .pending_prompt_id
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(id);
            owns_prompt_flag = true;
        }
        let result = session.send_rpc(command).await;
        if result.is_err()
            && !was_active
            && let Some(flag) = work_flag
        {
            flag.store(false, Ordering::Release);
            if owns_prompt_flag {
                *process
                    .pending_prompt_id
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
            }
        }
        runtime_trace(
            "chat.send.end",
            Some(session_key),
            session.stream_id(),
            json!({
                "command": command_type,
                "id": command_id,
                "ok": result.is_ok(),
                "elapsedMs": started.elapsed().as_millis(),
                "error": result.as_ref().err(),
            }),
        );
        result
    }

    async fn resource_change_candidates(
        &self,
        projects: &[String],
    ) -> Vec<(String, Arc<ChatProcess>)> {
        self.registry
            .lock()
            .await
            .processes
            .iter()
            .filter(|(_, process)| projects.contains(&process.project_id))
            .map(|(key, process)| (key.clone(), Arc::clone(process)))
            .collect()
    }

    pub(crate) async fn check_idle_for_resource_change(
        &self,
        projects: &[String],
    ) -> Result<(), String> {
        for (_, process) in self.resource_change_candidates(projects).await {
            let session = process.session.lock().await;
            if session.uses_ssh_workspace() {
                if process.active_turn.load(Ordering::Acquire)
                    || process.compacting.load(Ordering::Acquire)
                {
                    return Err(super::super::pi_workspace::RESOURCES_BUSY.to_owned());
                }
                session.check_idle().await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn stop_for_resource_change(&self, projects: &[String]) -> Result<(), String> {
        for (key, process) in self.resource_change_candidates(projects).await {
            // Keep the process registered if stop fails so a later save can try again.
            let mut session = process.session.lock().await;
            if session.uses_ssh_workspace() {
                session.stop_if_idle().await?;
                self.close_process(&key).await;
            }
        }
        Ok(())
    }

    pub async fn stop(&self, session_key: &str, reason: Option<&str>) -> Result<(), String> {
        let process = self.close_process(session_key).await;
        let Some(process) = process else {
            runtime_trace(
                "chat.stop",
                Some(session_key),
                None,
                json!({ "found": false, "reason": reason }),
            );
            return Ok(());
        };
        let mut session = process.session.lock().await;
        runtime_trace(
            "chat.stop.begin",
            Some(session_key),
            session.stream_id(),
            json!({
                "found": true,
                "reason": reason,
                "prepared": process.prepared.load(Ordering::Acquire),
                "initialized": process.initialized.load(Ordering::Acquire),
                "activeTurn": process.active_turn.load(Ordering::Acquire),
                "hasSessionPath": process
                    .session_path
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .is_some(),
            }),
        );
        let result = session.stop().await;
        runtime_trace(
            "chat.stop.end",
            Some(session_key),
            session.stream_id(),
            json!({
                "ok": result.is_ok(),
                "reason": reason,
                "error": result.as_ref().err(),
            }),
        );
        result?;
        Ok(())
    }

    pub(crate) async fn stop_session_file(
        &self,
        project: &Project,
        session_path: &str,
    ) -> Result<(), String> {
        // Pi and the index can use different separators for the same Windows path.
        let local_windows =
            cfg!(windows) && matches!(project.connection.kind, ConnectionKind::Local);
        let session_file = Path::new(session_path);
        // Persisted Pi IDs and runtime keys differ for chats started as drafts.
        let session_keys = {
            let registry = self.registry.lock().await;
            registry
                .processes
                .iter()
                .filter(|(_, process)| {
                    process.project_id == project.id
                        && process
                            .session_path
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .as_deref()
                            .is_some_and(|path| {
                                path == session_path
                                    || (local_windows && Path::new(path) == session_file)
                            })
                })
                .map(|(session_key, _)| session_key.clone())
                .collect::<Vec<_>>()
        };
        for session_key in session_keys {
            self.stop(&session_key, Some("session_delete")).await?;
        }
        Ok(())
    }

    pub async fn detach(&self, session_key: &str, reason: Option<&str>) -> Result<(), String> {
        let process = self.close_process(session_key).await;
        let Some(process) = process else {
            runtime_trace(
                "chat.detach",
                Some(session_key),
                None,
                json!({ "found": false, "reason": reason }),
            );
            return Ok(());
        };

        let detached_session_key = session_key.to_owned();
        let detached_reason = reason.map(str::to_owned);
        runtime_trace(
            "chat.detach",
            Some(session_key),
            None,
            json!({ "found": true, "reason": reason }),
        );

        tokio::spawn(async move {
            let mut session = process.session.lock().await;
            runtime_trace(
                "chat.detach.stop.begin",
                Some(&detached_session_key),
                session.stream_id(),
                json!({ "reason": detached_reason }),
            );
            let result = session.stop().await;
            runtime_trace(
                "chat.detach.stop.end",
                Some(&detached_session_key),
                session.stream_id(),
                json!({
                    "ok": result.is_ok(),
                    "reason": detached_reason,
                    "error": result.as_ref().err(),
                }),
            );
        });

        Ok(())
    }
}
