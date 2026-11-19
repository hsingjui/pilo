use std::sync::{Arc, atomic::Ordering};

use super::{ChatProcess, ChatSessions};

const MAX_CACHED_IDLE_CHAT_PROCESSES: usize = 4;
const IDLE_CHAT_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const IDLE_REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

impl ChatProcess {
    fn can_evict(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
            && !self.no_session
            && self.initialized.load(Ordering::Acquire)
            && !self.active_turn.load(Ordering::Acquire)
            && !self.compacting.load(Ordering::Acquire)
            && self
                .session_path
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some()
    }
}

impl ChatSessions {
    pub(crate) fn start_idle_reaper(&self) {
        let registry = Arc::downgrade(&self.registry);
        crate::runtime::tasks::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_REAP_INTERVAL).await;
                let Some(registry) = registry.upgrade() else {
                    break;
                };
                let sessions = Self { registry };
                if sessions.registry.lock().await.shutting_down {
                    break;
                }
                sessions.prune_idle_processes(None).await;
            }
        });
    }

    /// Reserve one cache slot for the requested session. Live turns and sessions
    /// that cannot be restored from Pi JSONL are never part of this idle budget.
    pub(super) async fn prune_idle(&self, retained_key: &str) {
        self.prune_idle_processes(Some(retained_key)).await;
    }

    async fn prune_idle_processes(&self, retained_key: Option<&str>) {
        let evicted = {
            let mut registry = self.registry.lock().await;
            let super::ChatRegistry {
                processes,
                idle_since,
                ..
            } = &mut *registry;
            idle_since.retain(|key, _| {
                processes
                    .get(key)
                    .is_some_and(|process| process.can_evict())
            });
            for (key, process) in processes.iter().filter(|(_, process)| process.can_evict()) {
                let used = process.last_used.load(Ordering::Acquire);
                let idle = idle_since
                    .entry(key.clone())
                    .or_insert_with(|| (used, std::time::Instant::now()));
                if idle.0 != used {
                    *idle = (used, std::time::Instant::now());
                }
            }
            let mut candidates = registry
                .processes
                .iter()
                .filter(|(key, process)| Some(key.as_str()) != retained_key && process.can_evict())
                .map(|(key, process)| (key.clone(), process.last_used.load(Ordering::Acquire)))
                .collect::<Vec<_>>();
            // A live Pilo warming lease is separate from user recency and the idle budget.
            let now = crate::runtime::storage::now_ms();
            candidates.retain(|(key, _)| {
                !registry
                    .snapshots
                    .get(key)
                    .and_then(|reader| reader.cache_keep_alive())
                    .is_some_and(|status| {
                        status.expires_at_ms > now
                            && matches!(status.status.as_str(), "scheduled" | "warming")
                    })
            });
            candidates.sort_by_key(|(_, last_used)| *last_used);
            let mut remaining = candidates.len();
            let budget = MAX_CACHED_IDLE_CHAT_PROCESSES - usize::from(retained_key.is_some());
            let mut evicted = Vec::new();
            for (key, _) in candidates {
                let expired = registry
                    .idle_since
                    .get(&key)
                    .is_some_and(|(_, since)| since.elapsed() >= IDLE_CHAT_TTL);
                if remaining <= budget && !expired {
                    continue;
                }
                let process = &registry.processes[&key];
                // A registry lookup clones the Arc before locking the session.
                // Protect both pending RPCs and initialization, not just live turns.
                if !process.can_evict()
                    || Arc::strong_count(process) != 1
                    || process.session.try_lock().is_err()
                {
                    continue;
                }
                if let Some(process) = registry.processes.remove(&key) {
                    registry.snapshots.remove(&key);
                    registry.idle_since.remove(&key);
                    process.mark_closed();
                    evicted.push((key, process));
                    remaining -= 1;
                }
            }
            evicted
        };
        for (key, process) in evicted {
            tokio::spawn(async move {
                if let Err(error) = process.session.lock().await.stop().await {
                    log::warn!(target: "chat-cache", "failed to stop idle session '{key}': {error}");
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64},
    };
    use tokio::sync::Mutex;

    fn process(last_used: u64) -> Arc<ChatProcess> {
        Arc::new(ChatProcess {
            events: Default::default(),
            turn: Arc::new(super::super::turn_projection::SessionTurn::new(true)),
            project_id: "project".to_owned(),
            no_session: false,
            extensions: Vec::new(),
            disable_builtin_tools: false,
            disable_extension_discovery: false,
            disable_context_files: false,
            session: Mutex::new(Default::default()),
            session_path: Arc::new(StdMutex::new(Some("session.jsonl".to_owned()))),
            control_reply: Arc::new(StdMutex::new(None)),
            initialization_stderr: Arc::new(StdMutex::new(String::new())),
            prepared: AtomicBool::new(true),
            initialized: AtomicBool::new(true),
            active_turn: Arc::new(AtomicBool::new(false)),
            compacting: Arc::new(AtomicBool::new(false)),
            pending_prompt_id: Arc::new(StdMutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            last_used: AtomicU64::new(last_used),
        })
    }

    #[tokio::test]
    async fn evicts_oldest_idle_sessions_and_keeps_requested_session() {
        let sessions = ChatSessions::default();
        for index in 0..6 {
            sessions
                .registry
                .lock()
                .await
                .processes
                .insert(index.to_string(), process(index));
        }
        sessions.prune_idle("0").await;
        let registry = sessions.registry.lock().await;
        assert_eq!(registry.processes.len(), MAX_CACHED_IDLE_CHAT_PROCESSES);
        assert!(registry.processes.contains_key("0"));
        assert!(!registry.processes.contains_key("1"));
        assert!(!registry.processes.contains_key("2"));
        assert!(registry.processes.contains_key("5"));
    }

    #[tokio::test]
    async fn failed_prompt_and_compaction_do_not_pin_idle_processes() {
        let sessions = ChatSessions::default();
        sessions
            .registry
            .lock()
            .await
            .processes
            .insert("idle".to_owned(), process(0));
        for command in ["prompt", "compact"] {
            assert!(
                sessions
                    .send("idle", serde_json::json!({ "type": command }))
                    .await
                    .is_err()
            );
            let registry = sessions.registry.lock().await;
            let process = &registry.processes["idle"];
            assert!(!process.active_turn.load(Ordering::Acquire));
            assert!(!process.compacting.load(Ordering::Acquire));
            assert!(process.pending_prompt_id.lock().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn protects_live_temporary_unsaved_and_in_use_sessions() {
        let sessions = ChatSessions::default();
        let busy = process(0);
        busy.active_turn.store(true, Ordering::Release);
        let compacting = process(0);
        compacting.compacting.store(true, Ordering::Release);
        let initializing = process(0);
        initializing.initialized.store(false, Ordering::Release);
        let mut temporary = process(0);
        Arc::get_mut(&mut temporary).unwrap().no_session = true;
        let unsaved = process(0);
        *unsaved.session_path.lock().unwrap() = None;
        let in_use = process(0);
        {
            let mut registry = sessions.registry.lock().await;
            registry.processes.insert("busy".to_owned(), busy);
            registry
                .processes
                .insert("compacting".to_owned(), compacting);
            registry
                .processes
                .insert("initializing".to_owned(), initializing);
            registry.processes.insert("temporary".to_owned(), temporary);
            registry.processes.insert("unsaved".to_owned(), unsaved);
            registry
                .processes
                .insert("in-use".to_owned(), Arc::clone(&in_use));
            for index in 1..8 {
                registry.processes.insert(index.to_string(), process(index));
            }
        }
        sessions.prune_idle("new").await;
        let registry = sessions.registry.lock().await;
        for key in [
            "busy",
            "compacting",
            "initializing",
            "temporary",
            "unsaved",
            "in-use",
        ] {
            assert!(registry.processes.contains_key(key));
        }
        assert!(!registry.processes.contains_key("1"));
        assert!(registry.processes.contains_key("7"));
    }
}
