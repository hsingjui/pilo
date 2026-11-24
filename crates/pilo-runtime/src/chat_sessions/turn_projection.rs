use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::events::{
    PiProcessState, RuntimeEvent, RuntimeEventBus, SequencedRuntimeEvent,
    turn_projection::{TurnLimits, TurnLive, TurnProjection},
};
use crate::{
    server_pi::SessionSnapshotReader,
    session_history::{
        RemoteTranscriptBase, SessionHistoryCache, TranscriptBase, empty_transcript_history,
        read_remote_transcript_history, read_transcript_history, record_remote_transcript_base,
        record_transcript_base,
    },
    transcript::{TranscriptSnapshot, TranscriptWindow},
};

pub(super) enum PromptMode {
    Idle,
    Steer,
    Queued,
}

pub(super) struct PromptStart {
    pub(super) generation: u64,
    pub(super) path: Option<String>,
    pub(super) id: Option<String>,
    pub(super) mode: PromptMode,
}

pub(super) struct SessionTurn {
    enabled: bool,
    may_be_unwritten: AtomicBool,
    remote: Option<SessionSnapshotReader>,
    state: Mutex<TurnState>,
}

enum TurnBase {
    Local(Arc<TranscriptBase>),
    Remote(RemoteTranscriptBase),
    /// Pi had not written the new session file yet, so the turn starts on an empty prefix.
    Unwritten,
}

impl TurnBase {
    fn size(&self) -> u64 {
        match self {
            Self::Local(base) => base.size,
            Self::Remote(base) => base.size(),
            Self::Unwritten => 0,
        }
    }
}

/// Whether a session read failed because the file does not exist (yet); the
/// Server reports the I/O error text, which ends with the OS error code.
fn unwritten_session_error(error: &str) -> bool {
    error.ends_with("(os error 2)")
}

async fn local_session_unwritten(path: &str) -> bool {
    matches!(
        tokio::fs::metadata(path).await,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

struct TurnState {
    base: Option<Arc<TurnBase>>,
    projection: TurnProjection,
    generation: u64,
    sequence: u64,
    revision: u64,
    running: bool,
    awaiting_agent_start: bool,
    expected_users: VecDeque<Option<String>>,
    prompt_id: Option<String>,
}

impl TurnState {
    fn idle(&self) -> bool {
        matches!(self.projection.snapshot().live, TurnLive::Idle)
    }

    fn active(&self) -> bool {
        matches!(self.projection.snapshot().live, TurnLive::Active { .. })
    }

    fn reset(&mut self) {
        self.base = None;
        self.projection.settle();
        self.running = false;
        self.awaiting_agent_start = false;
        self.expected_users.clear();
        self.prompt_id = None;
        self.revision = self.revision.wrapping_add(1);
    }

    fn generation(&mut self, generation: u64) -> bool {
        if generation < self.generation {
            return false;
        }
        if generation > self.generation {
            self.reset();
            self.generation = generation;
        }
        true
    }

    fn cancel_user(&mut self, id: Option<&str>) {
        if let Some(index) = self
            .expected_users
            .iter()
            .position(|pending| pending.as_deref() == id)
        {
            self.expected_users.remove(index);
        }
    }
}

impl SessionTurn {
    pub(super) async fn snapshot(
        &self,
        events: &RuntimeEventBus,
        session_key: &str,
        path: Option<String>,
        window: TranscriptWindow,
        history_cache: &tokio::sync::Mutex<SessionHistoryCache>,
        project_id: &str,
    ) -> Result<TranscriptSnapshot, String> {
        let Some(reader) = &self.remote else {
            return self
                .snapshot_with_reader(events, session_key, window, |base| {
                    let path = path.clone();
                    async move {
                        match (path, base) {
                            (Some(path), base) => {
                                let unanchored = base.is_none();
                                let result = read_transcript_history(
                                    path.clone(),
                                    base,
                                    window,
                                    history_cache,
                                    project_id,
                                )
                                .await;
                                if result.is_ok() {
                                    self.mark_persisted();
                                } else if unanchored
                                    && self.may_be_unwritten.load(Ordering::Acquire)
                                    && local_session_unwritten(&path).await
                                {
                                    return empty_transcript_history(window);
                                }
                                result
                            }
                            (None, None) => empty_transcript_history(window),
                            (None, Some(_)) => Err("transcript source is unavailable".to_owned()),
                        }
                    }
                })
                .await;
        };
        self.snapshot_with_source(events, session_key, window, |base| {
            let path = path.clone();
            async move {
                match (path, base.as_deref()) {
                    (Some(path), base) => {
                        let base = match base {
                            Some(TurnBase::Remote(base)) => Some(base),
                            Some(TurnBase::Unwritten) => return empty_transcript_history(window),
                            None => None,
                            _ => return Err("transcript source has changed".to_owned()),
                        };
                        let client = reader
                            .server_client()
                            .ok_or_else(|| "transcript source is unavailable".to_owned())?;
                        let result = read_remote_transcript_history(
                            &client,
                            project_id,
                            &path,
                            base,
                            window,
                            history_cache,
                        )
                        .await;
                        match result {
                            Err(error)
                                if base.is_none()
                                    && self.may_be_unwritten.load(Ordering::Acquire)
                                    && unwritten_session_error(&error) =>
                            {
                                empty_transcript_history(window)
                            }
                            Ok(history) => {
                                self.mark_persisted();
                                Ok(history)
                            }
                            Err(error) => Err(error),
                        }
                    }
                    (None, None) => empty_transcript_history(window),
                    (None, Some(_)) => Err("transcript source is unavailable".to_owned()),
                }
            }
        })
        .await
    }

    async fn snapshot_with_reader<
        F: std::future::Future<Output = Result<serde_json::Value, String>>,
    >(
        &self,
        events: &RuntimeEventBus,
        session_key: &str,
        window: TranscriptWindow,
        mut read: impl FnMut(Option<Arc<TranscriptBase>>) -> F,
    ) -> Result<TranscriptSnapshot, String> {
        self.snapshot_with_source(events, session_key, window, |base| {
            let read = match base.as_deref() {
                Some(TurnBase::Local(base)) => Ok(Some(read(Some(Arc::clone(base))))),
                Some(TurnBase::Unwritten) => Ok(None),
                None => Ok(Some(read(None))),
                _ => Err("transcript source has changed".to_owned()),
            };
            async move {
                match read? {
                    Some(read) => read.await,
                    None => empty_transcript_history(window),
                }
            }
        })
        .await
    }

    async fn snapshot_with_source<
        F: std::future::Future<Output = Result<serde_json::Value, String>>,
    >(
        &self,
        events: &RuntimeEventBus,
        session_key: &str,
        window: TranscriptWindow,
        mut read: impl FnMut(Option<Arc<TurnBase>>) -> F,
    ) -> Result<TranscriptSnapshot, String> {
        for attempt in 0..3 {
            let (projection, base, generation, revision, event_sequence) = events
                .with_publish_lock(|| {
                    let state = self
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    (
                        state.projection.snapshot(),
                        state.base.clone(),
                        state.generation,
                        state.revision,
                        events.latest_sequence(),
                    )
                });
            let mut live = projection.live;
            let history = if matches!(live, TurnLive::Truncated) {
                empty_transcript_history(window)?
            } else {
                let result = read(base.clone()).await;
                if matches!(live, TurnLive::Idle)
                    && !events.with_publish_lock(|| {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.generation == generation && state.revision == revision
                    })
                {
                    continue;
                }
                match result {
                    Ok(history) => history,
                    Err(_) if matches!(live, TurnLive::Idle) && attempt < 2 => continue,
                    Err(_) => {
                        live = TurnLive::Truncated;
                        if let Some(base) = &base {
                            events.with_publish_lock(|| {
                                let mut state = self
                                    .state
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                if state
                                    .base
                                    .as_ref()
                                    .is_some_and(|current| Arc::ptr_eq(current, base))
                                {
                                    state.projection.truncate();
                                    state.revision = state.revision.wrapping_add(1);
                                }
                            });
                        }
                        empty_transcript_history(window)?
                    }
                }
            };
            return Ok(TranscriptSnapshot {
                event_sequence,
                session_key: session_key.to_owned(),
                generation,
                history,
                live,
            });
        }
        Err("session changed while transcript was being read; retry the snapshot".to_owned())
    }

    pub(super) fn new(enabled: bool) -> Self {
        let mut projection = TurnProjection::new(TurnLimits {
            max_events: 2048,
            max_bytes: 16 * 1024 * 1024,
        });
        if !enabled {
            projection.truncate();
        }
        Self {
            enabled,
            may_be_unwritten: AtomicBool::new(false),
            remote: None,
            state: Mutex::new(TurnState {
                base: None,
                projection,
                generation: 0,
                sequence: 0,
                revision: 0,
                running: false,
                awaiting_agent_start: false,
                expected_users: VecDeque::new(),
                prompt_id: None,
            }),
        }
    }

    pub(super) fn new_remote(reader: SessionSnapshotReader) -> Self {
        Self {
            remote: Some(reader),
            ..Self::new(true)
        }
    }

    pub(super) fn allow_unwritten(self) -> Self {
        self.may_be_unwritten.store(true, Ordering::Release);
        self
    }

    pub(super) fn mark_persisted(&self) {
        self.may_be_unwritten.store(false, Ordering::Release);
    }

    pub(super) async fn send_prompt<F: std::future::Future<Output = Result<(), String>>>(
        &self,
        events: &RuntimeEventBus,
        start: PromptStart,
        send: impl FnOnce() -> F,
    ) -> Result<(), String> {
        self.prepare_prompt(
            events,
            start.generation,
            start.path,
            start.id.clone(),
            start.mode,
        )
        .await;
        let result = send().await;
        if result.is_err() {
            self.prompt_failed(events, start.id.as_deref());
        }
        result
    }

    async fn prepare_prompt(
        &self,
        events: &RuntimeEventBus,
        generation: u64,
        path: Option<String>,
        prompt_id: Option<String>,
        mode: PromptMode,
    ) {
        let token = events.with_publish_lock(|| {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !state.generation(generation) {
                return None;
            }
            if !self.enabled {
                state.projection.truncate();
                return None;
            }
            match mode {
                PromptMode::Steer => {
                    if state.active() {
                        state.expected_users.push_back(prompt_id.clone());
                    }
                    None
                }
                PromptMode::Queued => None,
                PromptMode::Idle if state.idle() && !state.running => {
                    Some((state.generation, state.sequence, state.revision))
                }
                PromptMode::Idle => None,
            }
        });
        let Some(token) = token else {
            return;
        };
        let base = match (path, &self.remote) {
            (Some(path), Some(reader)) => match reader.server_client() {
                // A slow or unavailable history probe must not block sending a prompt.
                Some(client) => match tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    record_remote_transcript_base(&client, path),
                )
                .await
                {
                    Ok(Ok(base)) => Some(TurnBase::Remote(base)),
                    Ok(Err(error))
                        if self.may_be_unwritten.load(Ordering::Acquire)
                            && unwritten_session_error(&error) =>
                    {
                        Some(TurnBase::Unwritten)
                    }
                    _ => None,
                },
                None => None,
            },
            (Some(path), None) => {
                if self.may_be_unwritten.load(Ordering::Acquire)
                    && local_session_unwritten(&path).await
                {
                    Some(TurnBase::Unwritten)
                } else {
                    tokio::task::spawn_blocking(move || record_transcript_base(path))
                        .await
                        .ok()
                        .flatten()
                        .map(TurnBase::Local)
                }
            }
            (None, _) => None,
        };
        events.with_publish_lock(|| {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.generation != token.0 {
                return;
            }
            if (state.generation, state.sequence, state.revision) != token {
                state.projection.truncate();
                state.prompt_id = prompt_id;
                return;
            }
            if let Some(base) = base.filter(|base| {
                !matches!(base, TurnBase::Unwritten)
                    || self.may_be_unwritten.load(Ordering::Acquire)
            }) {
                if !matches!(base, TurnBase::Unwritten) {
                    self.mark_persisted();
                }
                state.projection.begin(base.size());
                state.base = Some(Arc::new(base));
                state.awaiting_agent_start = true;
            } else {
                state.projection.truncate();
            }
            state.expected_users.push_back(prompt_id.clone());
            state.prompt_id = prompt_id;
            state.revision = state.revision.wrapping_add(1);
        });
    }

    pub(super) fn prompt_failed(&self, events: &RuntimeEventBus, prompt_id: Option<&str>) {
        events.with_publish_lock(|| {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if self.enabled && state.prompt_id.as_deref() == prompt_id && !state.running {
                state.reset();
            } else {
                state.cancel_user(prompt_id);
            }
        });
    }

    pub(super) fn agent_start(&self, events: &RuntimeEventBus, generation: u64) {
        events.with_publish_lock(|| {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !state.generation(generation) {
                return;
            }
            if !self.enabled || !state.awaiting_agent_start {
                state.projection.truncate();
            }
            state.awaiting_agent_start = false;
            state.running = true;
            state.revision = state.revision.wrapping_add(1);
        });
    }

    // Called only inside RuntimeEventBus's sequence-assignment lock.
    pub(super) fn observe(&self, sequenced: &SequencedRuntimeEvent) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.sequence = sequenced.sequence;
        state.revision = state.revision.wrapping_add(1);
        let event = &sequenced.event.event;
        if let Some(generation) = event_generation(event)
            && !state.generation(generation)
        {
            return;
        }
        if !self.enabled {
            state.projection.truncate();
            return;
        }
        match event {
            RuntimeEvent::PiReattached { active, .. } => {
                state.reset();
                if *active {
                    state.projection.truncate();
                }
                state.running = *active;
                return;
            }
            RuntimeEvent::AssistantMessageEnd { .. } => {
                // Pi has persisted the conversation by the end of the turn.
                self.mark_persisted();
                state.reset();
                return;
            }
            RuntimeEvent::UserMessageStart { .. } => {
                state.running = true;
                if state.expected_users.pop_front().is_none() {
                    state.projection.truncate();
                    return;
                }
            }
            RuntimeEvent::AssistantMessageStart { .. }
            | RuntimeEvent::AssistantTextDelta { .. }
            | RuntimeEvent::AssistantTextSnapshot { .. }
            | RuntimeEvent::AssistantThinkingStart { .. }
            | RuntimeEvent::AssistantThinkingDelta { .. }
            | RuntimeEvent::AssistantThinkingEnd { .. }
            | RuntimeEvent::ToolExecutionStart { .. }
            | RuntimeEvent::ToolExecutionUpdate { .. }
            | RuntimeEvent::ToolExecutionEnd { .. } => {
                state.running = true;
                if !state.active() {
                    state.projection.truncate();
                    return;
                }
            }
            RuntimeEvent::AutoRetryStart { .. } => {
                state.running = true;
                state.projection.truncate();
                return;
            }
            RuntimeEvent::CompactionEnd {
                will_retry: true, ..
            } => {
                if state.active() || state.running {
                    state.projection.truncate();
                }
                return;
            }
            RuntimeEvent::CompactionStart { .. }
            | RuntimeEvent::RuntimeError { .. }
            | RuntimeEvent::ProcessState {
                state: PiProcessState::Failed | PiProcessState::Stopped,
                ..
            } => {
                if state.active() {
                    state.projection.truncate();
                }
                return;
            }
            RuntimeEvent::RpcMessage { message, .. }
                if message["type"] == "response"
                    && (message["command"] == "prompt" || message["command"] == "steer") =>
            {
                let id = message.get("id").and_then(serde_json::Value::as_str);
                if message["success"] == false
                    || message
                        .pointer("/data/disposition")
                        .is_some_and(|value| value == "handled")
                {
                    if id == state.prompt_id.as_deref() {
                        if !state.running {
                            state.reset();
                            return;
                        }
                        state.projection.truncate();
                    }
                    state.cancel_user(id);
                } else if message
                    .pointer("/data/disposition")
                    .is_some_and(|value| value == "queued")
                {
                    if id == state.prompt_id.as_deref() {
                        state.projection.truncate();
                    }
                    state.cancel_user(id);
                }
            }
            _ => {}
        }
        if state.active() {
            state.projection.push(event.clone());
        }
    }
}

fn event_generation(event: &RuntimeEvent) -> Option<u64> {
    match event {
        RuntimeEvent::ProcessState { generation, .. }
        | RuntimeEvent::RpcMessage { generation, .. }
        | RuntimeEvent::UserMessageStart { generation, .. }
        | RuntimeEvent::AssistantMessageStart { generation }
        | RuntimeEvent::AssistantUsageUpdate { generation, .. }
        | RuntimeEvent::AssistantTextDelta { generation, .. }
        | RuntimeEvent::AssistantTextSnapshot { generation, .. }
        | RuntimeEvent::AssistantThinkingStart { generation }
        | RuntimeEvent::AssistantThinkingDelta { generation, .. }
        | RuntimeEvent::AssistantThinkingEnd { generation }
        | RuntimeEvent::ToolExecutionStart { generation, .. }
        | RuntimeEvent::ToolExecutionUpdate { generation, .. }
        | RuntimeEvent::ToolExecutionEnd { generation, .. }
        | RuntimeEvent::PiReattached { generation, .. }
        | RuntimeEvent::AssistantMessageEnd { generation, .. }
        | RuntimeEvent::QueueUpdate { generation, .. }
        | RuntimeEvent::CompactionStart { generation, .. }
        | RuntimeEvent::CompactionEnd { generation, .. }
        | RuntimeEvent::AutoRetryStart { generation, .. }
        | RuntimeEvent::AutoRetryEnd { generation, .. }
        | RuntimeEvent::SummarizationRetryScheduled { generation, .. }
        | RuntimeEvent::SummarizationRetryAttemptStart { generation, .. }
        | RuntimeEvent::SummarizationRetryFinished { generation }
        | RuntimeEvent::ExtensionUiRequest { generation, .. }
        | RuntimeEvent::RuntimeLog { generation, .. }
        | RuntimeEvent::RuntimeError { generation, .. } => Some(*generation),
        RuntimeEvent::PreferencesChanged { .. }
        | RuntimeEvent::ConfigurationChanged
        | RuntimeEvent::ThemeSettingsChanged { .. }
        | RuntimeEvent::SessionTurnCompleted { .. }
        | RuntimeEvent::SessionsIndexed { .. }
        | RuntimeEvent::SessionIndexError { .. }
        | RuntimeEvent::ExternalSessionActivityChanged { .. }
        | RuntimeEvent::SessionReadStateChanged { .. }
        | RuntimeEvent::CacheKeepAliveSettingsChanged { .. }
        | RuntimeEvent::NextPromptSettingsChanged { .. }
        | RuntimeEvent::PromptEnhancementSettingsChanged { .. }
        | RuntimeEvent::ProjectModelScopeChanged { .. } => None,
    }
}

#[cfg(test)]
#[path = "transcript_proof.rs"]
mod proof;

#[cfg(test)]
mod tests {
    use std::{
        fs::OpenOptions,
        io::Write,
        path::PathBuf,
        sync::{
            Arc, Barrier, Mutex as StdMutex,
            atomic::{AtomicBool, AtomicU64, Ordering},
        },
    };

    use serde_json::{Value, json};

    use super::*;
    use crate::{
        chat_sessions::event_sink::ChatEventSink,
        events::{
            EventBatch, EventQueueLimits, RuntimeEventEnvelope, RuntimeEventSink, RuntimeLogStream,
        },
    };

    static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Jsonl(PathBuf);

    impl Jsonl {
        fn new(bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pilo-turn-{}-{}.jsonl",
                std::process::id(),
                FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }

        fn path(&self) -> String {
            self.0.to_str().unwrap().to_owned()
        }
    }

    impl Drop for Jsonl {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    pub(super) fn sink(local: bool) -> ChatEventSink {
        ChatEventSink {
            events: RuntimeEventBus::default(),
            turn: Arc::new(SessionTurn::new(local)),
            session_key: "session".to_owned(),
            project_id: "project".to_owned(),
            control_reply: Arc::new(StdMutex::new(None)),
            initialization_stderr: Arc::new(StdMutex::new(String::new())),
            session_path: Arc::new(StdMutex::new(None)),
            active_turn: Arc::new(AtomicBool::new(false)),
            compacting: Arc::new(AtomicBool::new(false)),
            pending_prompt_id: Arc::new(StdMutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    fn start(file: &Jsonl, mode: PromptMode) -> PromptStart {
        PromptStart {
            generation: 1,
            path: Some(file.path()),
            id: Some("prompt-1".to_owned()),
            mode,
        }
    }

    async fn prepare(sink: &ChatEventSink, file: &Jsonl) {
        sink.turn
            .send_prompt(&sink.events, start(file, PromptMode::Idle), || async {
                Ok(())
            })
            .await
            .unwrap();
    }

    fn live(sink: &ChatEventSink) -> TurnLive {
        sink.events
            .with_publish_lock(|| sink.turn.state.lock().unwrap().projection.snapshot().live)
    }

    fn user() -> RuntimeEvent {
        RuntimeEvent::UserMessageStart {
            generation: 1,
            text: "prompt".to_owned(),
        }
    }
    fn text(delta: &str) -> RuntimeEvent {
        RuntimeEvent::AssistantTextDelta {
            generation: 1,
            delta: delta.to_owned(),
        }
    }
    fn settled() -> RuntimeEvent {
        RuntimeEvent::AssistantMessageEnd {
            generation: 1,
            stop_reason: Some("stop".to_owned()),
            error_message: None,
            usage: None,
        }
    }
    fn agent_start(sink: &ChatEventSink) {
        sink.turn.agent_start(&sink.events, 1);
    }

    #[tokio::test]
    async fn base_is_captured_before_the_prompt_writer_runs() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(true);
        sink.turn
            .send_prompt(&sink.events, start(&file, PromptMode::Idle), || async {
                let snapshot = sink.turn.state.lock().unwrap().projection.snapshot();
                assert_eq!(snapshot.base_size, Some(3));
                assert!(matches!(snapshot.live, TurnLive::Active { .. }));
                OpenOptions::new()
                    .append(true)
                    .open(&file.0)
                    .unwrap()
                    .write_all(b"{\"role\":\"user\"}\n")
                    .unwrap();
                Ok(())
            })
            .await
            .unwrap();
        assert!(std::fs::metadata(&file.0).unwrap().len() > 3);
        assert_eq!(
            sink.turn
                .state
                .lock()
                .unwrap()
                .projection
                .snapshot()
                .base_size,
            Some(3)
        );
    }

    #[tokio::test]
    async fn concurrent_publishers_project_the_bus_sequence_order() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        let barrier = Arc::new(Barrier::new(8));
        let threads = (0..8)
            .map(|worker| {
                let sink = sink.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    for index in 0..32 {
                        sink.send(text(&format!("{worker}:{index}")));
                        sink.send(RuntimeEvent::ToolExecutionUpdate {
                            generation: 1,
                            tool_call_id: format!("{worker}:{index}"),
                            tool_name: "bash".to_owned(),
                            args: json!({}),
                            partial_result: json!({"index": index}),
                        });
                    }
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        let replay = sink.events.replay_after(0).unwrap();
        let mut expected = TurnProjection::new(TurnLimits {
            max_events: 2048,
            max_bytes: 16 * 1024 * 1024,
        });
        assert!(expected.begin(3));
        for event in &replay {
            expected.push(event.event.event.clone());
        }
        sink.events.with_publish_lock(|| {
            let state = sink.turn.state.lock().unwrap();
            assert_eq!(state.projection.snapshot(), expected.snapshot());
            assert_eq!(state.sequence, replay.last().unwrap().sequence);
            assert_eq!(state.sequence, sink.events.latest_sequence());
        });
    }

    #[tokio::test]
    async fn idle_events_leave_idle_and_do_not_poison_the_next_prompt() {
        let sink = sink(true);
        for event in [
            RuntimeEvent::ProcessState {
                generation: 1,
                state: PiProcessState::Running,
            },
            RuntimeEvent::RpcMessage {
                generation: 1,
                message: json!({"type": "response", "command": "get_state", "success": true}),
            },
            RuntimeEvent::RuntimeLog {
                generation: 1,
                stream: RuntimeLogStream::Stderr,
                message: "diagnostic".to_owned(),
            },
            RuntimeEvent::QueueUpdate {
                generation: 1,
                steering: vec![],
                follow_up: vec![],
            },
            RuntimeEvent::CompactionStart {
                generation: 1,
                reason: "manual".to_owned(),
            },
            RuntimeEvent::CompactionEnd {
                generation: 1,
                reason: "manual".to_owned(),
                result: None,
                aborted: false,
                will_retry: false,
                error_message: None,
            },
        ] {
            sink.send(event);
            assert_eq!(live(&sink), TurnLive::Idle);
        }
        let file = Jsonl::new(b"{}\n");
        prepare(&sink, &file).await;
        let TurnLive::Active { events } = live(&sink) else {
            panic!("next prompt must be active");
        };
        assert!(events.is_empty());
        sink.send(user());
        let TurnLive::Active { events } = live(&sink) else {
            panic!("prompt user echo must stay active");
        };
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn autonomous_and_attached_turns_are_truncated() {
        for event in [
            user(),
            RuntimeEvent::AssistantMessageStart { generation: 1 },
            RuntimeEvent::PiReattached {
                generation: 1,
                active: true,
                compacting: false,
            },
        ] {
            let sink = sink(true);
            sink.send(event);
            assert_eq!(live(&sink), TurnLive::Truncated);
        }
        let sink = sink(true);
        agent_start(&sink);
        assert_eq!(live(&sink), TurnLive::Truncated);
    }

    #[tokio::test]
    async fn queued_follow_ups_and_second_agent_runs_are_not_recorded_starts() {
        let file = Jsonl::new(b"{}\n");
        for raw_restart in [false, true] {
            let sink = sink(true);
            prepare(&sink, &file).await;
            agent_start(&sink);
            sink.send(user());
            if raw_restart {
                agent_start(&sink);
            } else {
                sink.turn
                    .send_prompt(&sink.events, start(&file, PromptMode::Queued), || async {
                        Ok(())
                    })
                    .await
                    .unwrap();
                sink.send(user());
            }
            assert_eq!(live(&sink), TurnLive::Truncated);
        }
    }

    #[tokio::test]
    async fn steer_echoes_remain_in_the_recorded_turn() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        sink.send(text("before"));
        sink.turn
            .send_prompt(&sink.events, start(&file, PromptMode::Steer), || async {
                Ok(())
            })
            .await
            .unwrap();
        sink.send(user());
        sink.send(text("after"));
        let TurnLive::Active { events } = live(&sink) else {
            panic!("steer must not reset the turn");
        };
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.as_ref(), RuntimeEvent::UserMessageStart { .. }))
                .count(),
            2
        );
        assert_eq!(
            sink.turn
                .state
                .lock()
                .unwrap()
                .projection
                .snapshot()
                .base_size,
            Some(3)
        );
    }

    #[tokio::test]
    async fn retry_and_compaction_invalidate_a_previously_recorded_turn() {
        let file = Jsonl::new(b"{}\n");
        for event in [
            RuntimeEvent::AutoRetryStart {
                generation: 1,
                attempt: 1,
                max_attempts: 3,
                delay_ms: 10,
                error_message: "retry".to_owned(),
            },
            RuntimeEvent::CompactionStart {
                generation: 1,
                reason: "auto".to_owned(),
            },
            RuntimeEvent::CompactionEnd {
                generation: 1,
                reason: "auto".to_owned(),
                result: None,
                aborted: false,
                will_retry: true,
                error_message: None,
            },
        ] {
            let sink = sink(true);
            prepare(&sink, &file).await;
            agent_start(&sink);
            sink.send(user());
            sink.send(event);
            assert_eq!(live(&sink), TurnLive::Truncated);
            sink.send(settled());
            assert_eq!(live(&sink), TurnLive::Idle);
        }
    }

    #[tokio::test]
    async fn failed_or_rejected_steers_do_not_authorize_a_queued_follow_up() {
        let file = Jsonl::new(b"{}\n");
        for transport_failure in [false, true] {
            let sink = sink(true);
            prepare(&sink, &file).await;
            agent_start(&sink);
            sink.send(user());
            let mut steer = start(&file, PromptMode::Steer);
            steer.id = Some("steer-2".to_owned());
            let _ = sink
                .turn
                .send_prompt(&sink.events, steer, || async {
                    if transport_failure {
                        Err("write failed".to_owned())
                    } else {
                        Ok(())
                    }
                })
                .await;
            if !transport_failure {
                sink.send(RuntimeEvent::RpcMessage { generation: 1, message: json!({"type":"response", "command":"prompt", "id":"steer-2", "success":false}) });
            }
            assert!(matches!(live(&sink), TurnLive::Active { .. }));
            sink.send(user());
            assert_eq!(live(&sink), TurnLive::Truncated);
        }
    }

    #[tokio::test]
    async fn remote_snapshot_is_truncated_without_reading_history() {
        let turn = SessionTurn::new(false);
        let events = RuntimeEventBus::default();
        let mut reads = 0;
        let snapshot = turn
            .snapshot_with_reader(
                &events,
                "remote-session",
                TranscriptWindow::default(),
                |_| {
                    reads += 1;
                    async { Ok(json!({"unexpected": true})) }
                },
            )
            .await
            .unwrap();

        assert_eq!(reads, 0);
        assert_eq!(snapshot.live, TurnLive::Truncated);
        assert_eq!(snapshot.history["history"]["events"], json!([]));
    }

    #[tokio::test]
    async fn remote_stays_truncated_across_start_settle_and_restart() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(false);
        assert_eq!(live(&sink), TurnLive::Truncated);
        prepare(&sink, &file).await;
        for event in [
            user(),
            text("reply"),
            settled(),
            RuntimeEvent::ProcessState {
                generation: 2,
                state: PiProcessState::Starting,
            },
        ] {
            sink.send(event);
            assert_eq!(live(&sink), TurnLive::Truncated);
        }
    }

    #[tokio::test]
    async fn settle_clears_the_turn_and_next_prompt_advances_the_base() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        sink.send(text("reply"));
        sink.send(settled());
        assert_eq!(live(&sink), TurnLive::Idle);
        assert_eq!(
            sink.turn
                .state
                .lock()
                .unwrap()
                .projection
                .snapshot()
                .base_size,
            None
        );
        std::fs::write(&file.0, b"{}\n{}\n").unwrap();
        prepare(&sink, &file).await;
        assert_eq!(
            sink.turn
                .state
                .lock()
                .unwrap()
                .projection
                .snapshot()
                .base_size,
            Some(6)
        );
        assert!(matches!(live(&sink), TurnLive::Active { .. }));
    }

    #[tokio::test]
    async fn generation_changes_and_reattach_discard_the_old_projection() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        sink.send(text("old"));
        sink.send(RuntimeEvent::ProcessState {
            generation: 2,
            state: PiProcessState::Starting,
        });
        assert_eq!(live(&sink), TurnLive::Idle);
        sink.send(text("late old generation"));
        assert_eq!(live(&sink), TurnLive::Idle);
        let mut next = start(&file, PromptMode::Idle);
        next.generation = 2;
        sink.turn
            .send_prompt(&sink.events, next, || async { Ok(()) })
            .await
            .unwrap();
        assert!(matches!(live(&sink), TurnLive::Active { .. }));
        sink.send(RuntimeEvent::PiReattached {
            generation: 2,
            active: true,
            compacting: false,
        });
        assert_eq!(live(&sink), TurnLive::Truncated);
        sink.send(RuntimeEvent::PiReattached {
            generation: 2,
            active: false,
            compacting: true,
        });
        assert_eq!(live(&sink), TurnLive::Idle);
    }

    #[tokio::test]
    async fn unsafe_boundaries_truncate_and_transport_failures_release_the_pending_turn() {
        let partial = Jsonl::new(b"{}");
        for path in [
            None,
            Some(partial.path()),
            Some(format!("{}.missing", partial.path())),
        ] {
            let sink = sink(true);
            let mut request = start(&partial, PromptMode::Idle);
            request.path = path;
            sink.turn
                .send_prompt(&sink.events, request, || async { Ok(()) })
                .await
                .unwrap();
            assert_eq!(live(&sink), TurnLive::Truncated);
            sink.send(settled());
            assert_eq!(live(&sink), TurnLive::Idle);
        }
        let file = Jsonl::new(b"");
        let sink = sink(true);
        assert!(
            sink.turn
                .send_prompt(&sink.events, start(&file, PromptMode::Idle), || async {
                    Err("writer failed".to_owned())
                })
                .await
                .is_err()
        );
        assert_eq!(live(&sink), TurnLive::Idle);
        prepare(&sink, &file).await;
        assert_eq!(
            sink.turn
                .state
                .lock()
                .unwrap()
                .projection
                .snapshot()
                .base_size,
            Some(0)
        );
    }

    #[tokio::test]
    async fn prompt_rejected_or_handled_without_a_turn_returns_to_idle() {
        let file = Jsonl::new(b"{}\n");
        for (success, disposition) in [(false, "rejected"), (true, "handled")] {
            let sink = sink(true);
            prepare(&sink, &file).await;
            sink.send(RuntimeEvent::RpcMessage { generation: 1, message: json!({"type":"response", "command":"prompt", "id":"prompt-1", "success":success, "data":{"disposition":disposition}}) });
            assert_eq!(live(&sink), TurnLive::Idle);
            prepare(&sink, &file).await;
            assert!(matches!(live(&sink), TurnLive::Active { .. }));
        }
    }

    #[tokio::test]
    async fn projected_events_leave_host_and_web_payload_bytes_unchanged() {
        let file = Jsonl::new(b"{}\n");
        let sink = sink(true);
        prepare(&sink, &file).await;
        let reference = RuntimeEventBus::default();
        let limits = EventQueueLimits {
            max_events: 32,
            max_bytes: 256 * 1024,
        };
        let mut wired_stream = sink.events.subscribe_events(limits);
        let mut reference_stream = reference.subscribe_events(limits);
        let mut wired_web = sink.events.subscribe_web();
        let mut reference_web = reference.subscribe_web();
        for event in [
            user(),
            text("a"),
            text("b"),
            RuntimeEvent::AssistantThinkingStart { generation: 1 },
            RuntimeEvent::AssistantThinkingDelta {
                generation: 1,
                delta: "think".to_owned(),
            },
            RuntimeEvent::AssistantThinkingEnd { generation: 1 },
            settled(),
        ] {
            sink.send(event.clone());
            let wired = wired_web.try_recv().unwrap();
            let mut envelope =
                RuntimeEventEnvelope::session("session".to_owned(), "project".to_owned(), event);
            envelope.timestamp_ms = wired.event.timestamp_ms;
            reference.send(envelope);
            assert_eq!(
                serde_json::to_vec(wired.as_ref()).unwrap(),
                serde_json::to_vec(reference_web.try_recv().unwrap().as_ref()).unwrap()
            );
        }
        let Some(EventBatch::Events(wired_events)) = wired_stream.try_next_batch(32) else {
            panic!("expected wired stream events");
        };
        let Some(EventBatch::Events(reference_events)) = reference_stream.try_next_batch(32) else {
            panic!("expected reference stream events");
        };
        assert_eq!(
            serde_json::to_vec(&wired_events).unwrap(),
            serde_json::to_vec(&reference_events).unwrap()
        );
        assert_eq!(wired_events.len(), 7);
    }

    #[tokio::test]
    async fn message_ends_and_tool_execution_keep_the_turn_active_until_agent_settled() {
        #[derive(Debug, Default, PartialEq)]
        struct Transcript(Vec<Value>);

        impl Transcript {
            fn assistant(&mut self) -> &mut Value {
                if self
                    .0
                    .last()
                    .is_none_or(|message| message["role"] != "assistant")
                {
                    self.0
                        .push(json!({"role":"assistant", "blocks":[], "complete":false}));
                }
                self.0.last_mut().unwrap()
            }

            fn apply(&mut self, event: &Value) {
                match event["type"].as_str().unwrap() {
                    "user_message_start" => {
                        self.0.push(json!({"role":"user", "text":event["text"]}));
                    }
                    "assistant_message_start" => {
                        self.assistant();
                    }
                    "assistant_text_delta" => {
                        let delta = event["delta"].as_str().unwrap();
                        let blocks = self.assistant()["blocks"].as_array_mut().unwrap();
                        if let Some(block) =
                            blocks.last_mut().filter(|block| block["type"] == "text")
                        {
                            block["text"] =
                                json!(format!("{}{}", block["text"].as_str().unwrap(), delta));
                        } else {
                            blocks.push(json!({"type":"text", "text":delta}));
                        }
                    }
                    "assistant_text_snapshot" => {
                        let text: String = self.assistant()["blocks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|block| block["type"] == "text")
                            .map(|block| block["text"].as_str().unwrap())
                            .collect();
                        assert_eq!(event["text"], text);
                    }
                    "tool_execution_start" => {
                        self.assistant()["blocks"].as_array_mut().unwrap().push(json!({
                            "type":"tool", "toolCallId":event["toolCallId"], "toolName":event["toolName"],
                            "args":event["args"], "result":null, "isError":false,
                        }));
                    }
                    "tool_execution_update" | "tool_execution_end" => {
                        let block = self.assistant()["blocks"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|block| {
                                block["type"] == "tool"
                                    && block["toolCallId"] == event["toolCallId"]
                            })
                            .unwrap();
                        if event["type"] == "tool_execution_update" {
                            block["result"] = event["partialResult"].clone();
                        } else {
                            block["result"] = event["result"].clone();
                            block["isError"] = event["isError"].clone();
                        }
                    }
                    "assistant_message_end" | "assistant_turn_end" => {
                        let message = self.assistant();
                        message["complete"] = json!(true);
                        message["stopReason"] = event["stopReason"].clone();
                        message["errorMessage"] = event["errorMessage"].clone();
                        message["usage"] = event["usage"].clone();
                    }
                    other => panic!("unexpected transcript event: {other}"),
                }
            }
        }

        let file = Jsonl::new(b"{\"type\":\"session\",\"version\":3,\"id\":\"test\"}\n");
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        let mut adapter = crate::pi_events::PiEventAdapter::default();
        let mut published = Vec::new();
        let mut assistant_message_ends = 0;
        let mut publish = |raw: Value| {
            if raw["type"] == "message_end" && raw["message"]["role"] == "assistant" {
                assistant_message_ends += 1;
            }
            for event in adapter.adapt(1, &raw) {
                assert_eq!(
                    matches!(event, RuntimeEvent::AssistantMessageEnd { .. }),
                    raw["type"] == "agent_settled"
                );
                sink.send(event.clone());
                published.push(event);
                if raw["type"] != "agent_settled" {
                    assert!(matches!(live(&sink), TurnLive::Active { .. }), "{raw}");
                }
            }
            if raw["type"] == "agent_settled" {
                assert_eq!(live(&sink), TurnLive::Idle);
            } else {
                assert!(matches!(live(&sink), TurnLive::Active { .. }), "{raw}");
            }
        };
        let persist = |id: &str, parent: Option<&str>, message: &Value| {
            let entry = json!({"type":"message", "id":id, "parentId":parent, "message":message});
            writeln!(
                OpenOptions::new().append(true).open(&file.0).unwrap(),
                "{entry}"
            )
            .unwrap();
        };

        let user = json!({"role":"user", "content":[{"type":"text", "text":"List the files, then summarize."}]});
        publish(json!({"type":"message_start", "message":user}));
        publish(json!({"type":"message_end", "message":user}));
        persist("user", None, &user);

        publish(json!({"type":"message_start", "message":{"role":"assistant"}}));
        publish(
            json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta", "delta":"Listing files."}}),
        );
        let first = json!({"role":"assistant", "content":[
            {"type":"text", "text":"Listing files."},
            {"type":"toolCall", "id":"call-1", "name":"bash", "arguments":{"command":"ls"}},
        ], "stopReason":"toolUse"});
        publish(json!({"type":"message_end", "message":first}));
        persist("assistant-1", Some("user"), &first);

        publish(
            json!({"type":"tool_execution_start", "toolCallId":"call-1", "toolName":"bash", "args":{"command":"ls"}}),
        );
        publish(
            json!({"type":"tool_execution_update", "toolCallId":"call-1", "toolName":"bash", "args":{"command":"ls"}, "partialResult":{"content":[{"type":"text", "text":"a.txt\n"}]}}),
        );
        let result = json!({"content":[{"type":"text", "text":"a.txt\nb.txt\n"}]});
        publish(
            json!({"type":"tool_execution_end", "toolCallId":"call-1", "toolName":"bash", "result":result, "isError":false}),
        );
        let tool = json!({"role":"toolResult", "toolCallId":"call-1", "toolName":"bash", "content":result["content"], "isError":false});
        publish(json!({"type":"message_end", "message":tool}));
        persist("tool", Some("assistant-1"), &tool);

        publish(json!({"type":"message_start", "message":{"role":"assistant"}}));
        publish(
            json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta", "delta":"There are two files."}}),
        );
        let second = json!({"role":"assistant", "content":[{"type":"text", "text":"There are two files."}], "stopReason":"stop"});
        publish(json!({"type":"message_end", "message":second}));
        persist("assistant-2", Some("tool"), &second);

        let TurnLive::Active { events } = live(&sink) else {
            panic!("second message_end settled the turn");
        };
        let mut projected = Transcript::default();
        for event in events.iter() {
            projected.apply(&serde_json::to_value(&**event).unwrap());
        }
        publish(json!({"type":"agent_settled"}));
        assert_eq!(assistant_message_ends, 2);
        let mut raw = Transcript::default();
        for event in &published {
            raw.apply(&serde_json::to_value(event).unwrap());
        }
        projected.apply(&serde_json::to_value(published.last().unwrap()).unwrap());
        assert_eq!(projected, raw);

        let snapshot = crate::session_history::full_history_snapshot_for_test(
            &std::fs::read(&file.0).unwrap(),
        );
        let mut history = Transcript::default();
        for event in snapshot["history"]["events"].as_array().unwrap() {
            history.apply(event);
        }
        assert_eq!(history, raw);
        assert_eq!(history.0.len(), 2);
        assert_eq!(history.0[1]["blocks"].as_array().unwrap().len(), 3);
        assert!(
            sink.turn
                .state
                .lock()
                .unwrap()
                .projection
                .snapshot()
                .base_size
                .is_none()
        );
    }
}
