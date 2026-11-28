use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
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
    in_memory: bool,
    may_be_unwritten: AtomicBool,
    remote: Option<SessionSnapshotReader>,
    state: Mutex<TurnState>,
}

enum TurnBase {
    Local(Arc<TranscriptBase>),
    Remote(RemoteTranscriptBase),
    /// Pi had not written the new session file yet, so the turn starts on an empty prefix.
    Unwritten,
    InMemory,
}

impl TurnBase {
    fn size(&self) -> u64 {
        match self {
            Self::Local(base) => base.size,
            Self::Remote(base) => base.size(),
            Self::Unwritten | Self::InMemory => 0,
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
    started_at: Option<(i64, Instant)>,
    awaiting_agent_start: bool,
    step_has_output: bool,
    last_text_snapshot: String,
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
        self.started_at = None;
        self.awaiting_agent_start = false;
        self.step_has_output = false;
        self.last_text_snapshot.clear();
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
        if self.in_memory {
            return self
                .snapshot_with_source(events, session_key, window, |_| async {
                    empty_transcript_history(window)
                })
                .await;
        }
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
            let (projection, user_images, base, generation, revision, event_sequence, started_at) =
                events.with_publish_lock(|| {
                    let state = self
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    (
                        state.projection.snapshot(),
                        state.projection.user_images(),
                        state.base.clone(),
                        state.generation,
                        state.revision,
                        events.latest_sequence(),
                        state.started_at,
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
            let live_started_at_ms = started_at
                .filter(|_| matches!(live, TurnLive::Active { .. }))
                .map(|(timestamp, _)| timestamp);
            // A truncated turn can still have a known start, e.g. a queued user echo.
            let live_elapsed_ms = started_at
                .filter(|_| !matches!(live, TurnLive::Idle))
                .and_then(|(_, instant)| u64::try_from(instant.elapsed().as_millis()).ok());
            return Ok(TranscriptSnapshot {
                event_sequence,
                session_key: session_key.to_owned(),
                generation,
                history,
                live_started_at_ms,
                live_elapsed_ms,
                live_user_images: if matches!(live, TurnLive::Active { .. }) {
                    user_images
                } else {
                    None
                },
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
            in_memory: false,
            may_be_unwritten: AtomicBool::new(false),
            remote: None,
            state: Mutex::new(TurnState {
                base: None,
                projection,
                generation: 0,
                sequence: 0,
                revision: 0,
                running: false,
                started_at: None,
                awaiting_agent_start: false,
                step_has_output: false,
                last_text_snapshot: String::new(),
                expected_users: VecDeque::new(),
                prompt_id: None,
            }),
        }
    }

    pub(super) fn new_in_memory() -> Self {
        Self {
            in_memory: true,
            ..Self::new(true)
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
            _ if self.in_memory => Some(TurnBase::InMemory),
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
        if let Some(generation) = event.generation()
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
                state.step_has_output = false;
                state.last_text_snapshot.clear();
                state.started_at = sequenced.event.timestamp_ms.map(|ms| (ms, Instant::now()));
                if state.expected_users.pop_front().is_none() {
                    state.projection.truncate();
                    return;
                }
            }
            RuntimeEvent::AssistantMessageStart { .. } => {
                state.running = true;
                state.step_has_output = false;
                if !state.active() {
                    state.projection.truncate();
                    return;
                }
                if state.started_at.is_none() {
                    state.started_at = sequenced.event.timestamp_ms.map(|ms| (ms, Instant::now()));
                }
            }
            RuntimeEvent::AssistantTextSnapshot { text, .. } => {
                state.running = true;
                if text != &state.last_text_snapshot {
                    state.step_has_output = true;
                    state.last_text_snapshot.clone_from(text);
                }
                if !state.active() {
                    state.projection.truncate();
                    return;
                }
            }
            RuntimeEvent::AssistantTextDelta { delta, .. }
            | RuntimeEvent::AssistantThinkingDelta { delta, .. } => {
                state.running = true;
                if !delta.is_empty() {
                    state.step_has_output = true;
                }
                if !state.active() {
                    state.projection.truncate();
                    return;
                }
            }
            RuntimeEvent::AssistantThinkingStart { .. }
            | RuntimeEvent::AssistantThinkingEnd { .. }
            | RuntimeEvent::ToolExecutionStart { .. }
            | RuntimeEvent::ToolExecutionUpdate { .. }
            | RuntimeEvent::ToolExecutionEnd { .. } => {
                state.running = true;
                state.step_has_output = true;
                if !state.active() {
                    state.projection.truncate();
                    return;
                }
            }
            RuntimeEvent::AutoRetryStart { .. } => {
                state.running = true;
                // Transient errors before any visible output (e.g. 503/429 with
                // empty content) leave no rolled-back content in the projection,
                // so accept the retry's next agent_start instead of truncating.
                if state.active() && !state.step_has_output {
                    state.awaiting_agent_start = true;
                } else {
                    state.projection.truncate();
                }
                return;
            }
            RuntimeEvent::CompactionStart { .. } => {
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
            RuntimeEvent::CompactionEnd {
                will_retry: false,
                aborted: false,
                result: Some(_),
                ..
            } => {
                state.step_has_output = false;
                state.last_text_snapshot.clear();
                state.started_at = None;
            }
            RuntimeEvent::CompactionEnd { .. } => {
                return;
            }
            RuntimeEvent::RuntimeError { .. }
            | RuntimeEvent::ProcessState {
                state: PiProcessState::Failed | PiProcessState::Stopped,
                ..
            } => {
                state.started_at = None;
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
            if sequenced.event.images.is_empty() {
                state.projection.push(event.clone());
            } else {
                state
                    .projection
                    .push_with_images(event.clone(), sequenced.event.images.clone());
            }
        }
    }
}

#[cfg(test)]
#[path = "transcript_proof.rs"]
mod proof;

#[cfg(test)]
#[path = "turn_projection_tests.rs"]
mod tests;
