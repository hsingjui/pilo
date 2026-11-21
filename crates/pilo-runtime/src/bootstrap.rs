use serde::Serialize;

use super::{
    Runtime,
    chat_sessions::ChatSessionState,
    preferences::{self, PreferencesSnapshot},
    project,
};

/// State read after the event cut, not an atomic cross-service snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub event_sequence: u64,
    pub projects: Vec<pilo_domain::Project>,
    pub chat_sessions: Vec<ChatSessionState>,
    pub preferences: PreferencesSnapshot,
}

impl Runtime {
    /// Subscribe first so events arriving during snapshot reads remain queued.
    /// This cut is not a transcript watermark and must not suppress session deltas.
    pub async fn bootstrap_snapshot(&self) -> Result<BootstrapSnapshot, String> {
        let event_sequence = self.events.snapshot_sequence();
        let projects = project::list(self)?;
        let preferences = preferences::load(&self.paths)?;
        let chat_sessions = self.chat_sessions.states().await;
        Ok(BootstrapSnapshot {
            event_sequence,
            projects,
            chat_sessions,
            preferences,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        events::{
            EventBatch, EventQueueLimits, RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope,
        },
        host_events::RecordingEvents,
        host_paths::HostPaths,
        storage,
    };
    use std::{
        path::PathBuf,
        sync::{
            Arc, OnceLock,
            atomic::{AtomicUsize, Ordering},
        },
    };

    pub(crate) fn runtime_with_mid_snapshot_change(label: &str) -> (Runtime, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "pilo-bootstrap-{label}-{}-{}",
            std::process::id(),
            storage::now_ms()
        ));
        let directory = root.clone();
        let events = Arc::new(OnceLock::<RuntimeEventBus>::new());
        let bus = Arc::clone(&events);
        let reads = AtomicUsize::new(0);
        let paths = HostPaths::with_data_dir_resolver(PathBuf::new(), move || {
            let read = reads.fetch_add(1, Ordering::SeqCst);
            if read == 1 {
                let db = storage::open_with_paths(&HostPaths::for_test(directory.clone())).unwrap();
                db.execute_batch("INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
                    VALUES('changed','local','changed','/changed','{\"cwd\":\"/changed\",\"gitBranch\":null,\"piVersion\":\"test\",\"refreshedAtMs\":0}',0,0);").unwrap();
            }
            if read <= 1 {
                bus.get().unwrap().send(RuntimeEventEnvelope::global(
                    RuntimeEvent::ConfigurationChanged,
                ));
            }
            Ok(directory.clone())
        });
        let runtime = Runtime::new(paths, Arc::new(RecordingEvents::default()));
        assert!(events.set(runtime.events.clone()).is_ok());
        runtime.events.send(RuntimeEventEnvelope::global(
            RuntimeEvent::ConfigurationChanged,
        ));
        (runtime, root)
    }

    #[tokio::test]
    async fn cut_precedes_first_snapshot_read_and_keeps_a_later_change_in_events() {
        let (runtime, root) = runtime_with_mid_snapshot_change("runtime-cut");
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 10,
            max_bytes: 4096,
        });
        let snapshot = runtime.bootstrap_snapshot().await.unwrap();
        assert_eq!(snapshot.event_sequence, 1);
        assert!(
            !snapshot
                .projects
                .iter()
                .any(|project| project.id == "changed")
        );
        assert!(
            project::list(&runtime)
                .unwrap()
                .iter()
                .any(|project| project.id == "changed")
        );
        let EventBatch::Events(events) = stream.try_next_batch(10).unwrap() else {
            panic!("expected events after cut")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(serde_json::to_value(&snapshot).unwrap()["eventSequence"], 1);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn empty_store_returns_default_state_and_zero_cut() {
        let root = std::env::temp_dir().join(format!(
            "pilo-bootstrap-empty-{}-{}",
            std::process::id(),
            storage::now_ms()
        ));
        let runtime = Runtime::new(
            HostPaths::for_test(root.clone()),
            Arc::new(RecordingEvents::default()),
        );
        let snapshot = runtime.bootstrap_snapshot().await.unwrap();
        assert_eq!(snapshot.event_sequence, 0);
        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.chat_sessions.is_empty());
        assert_eq!(snapshot.preferences.revision, 0);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn bootstrap_propagates_storage_errors() {
        let paths =
            HostPaths::with_data_dir_resolver(PathBuf::new(), || Err("data unavailable".into()));
        let runtime = Runtime::new(paths, Arc::new(RecordingEvents::default()));
        assert!(
            matches!(runtime.bootstrap_snapshot().await, Err(error) if error == "data unavailable")
        );
    }
}
