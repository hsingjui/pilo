use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex as StdMutex, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    task::JoinHandle,
};

use pilo_domain::Project;

use super::{
    host_api::Principal,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager},
};

static TERMINAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Maximum buffered terminal payload kept per subscriber before dropping the oldest event.
pub const TERMINAL_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Maximum recent PTY output retained per terminal for reconnect catch-up snapshots.
pub const TERMINAL_SNAPSHOT_MAX_BYTES: usize = 64 * 1024;
/// How long a remote-owned PTY stays alive after its owner disconnects before closing.
pub const TERMINAL_DISCONNECT_RETENTION: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalOwner {
    Local,
    Device(String),
}

impl TerminalOwner {
    pub(crate) fn from_principal(principal: &Principal) -> Self {
        match principal {
            Principal::Local => Self::Local,
            Principal::Device { id, .. } => Self::Device(id.clone()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TerminalAccessError {
    NotFound(String),
    Forbidden(String),
    Internal(String),
}

impl TerminalAccessError {
    pub fn into_message(self) -> String {
        match self {
            Self::NotFound(message) | Self::Forbidden(message) | Self::Internal(message) => message,
        }
    }
}

#[derive(Default)]
struct OutputRingBuffer {
    bytes: VecDeque<u8>,
}

impl OutputRingBuffer {
    fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        if data.len() >= TERMINAL_SNAPSHOT_MAX_BYTES {
            self.bytes.clear();
            let start = data.len() - TERMINAL_SNAPSHOT_MAX_BYTES;
            self.bytes.extend(&data[start..]);
            return;
        }
        let overflow = (self.bytes.len() + data.len()).saturating_sub(TERMINAL_SNAPSHOT_MAX_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
        self.bytes.extend(data);
    }

    fn snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes.len());
        let (front, back) = self.bytes.as_slices();
        out.extend_from_slice(front);
        out.extend_from_slice(back);
        out
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    Output {
        terminal_id: String,
        data: Vec<u8>,
    },
    Exit {
        terminal_id: String,
    },
    Error {
        terminal_id: String,
        message: String,
    },
}

impl TerminalEvent {
    fn approx_bytes(&self) -> usize {
        match self {
            Self::Output { terminal_id, data } => 64 + terminal_id.len() + data.len(),
            Self::Exit { terminal_id } => 64 + terminal_id.len(),
            Self::Error {
                terminal_id,
                message,
            } => 64 + terminal_id.len() + message.len(),
        }
    }
}

#[derive(Default)]
struct TerminalQueueState {
    events: VecDeque<(usize, TerminalEvent)>,
    bytes: usize,
    closed: bool,
}

struct TerminalStreamInner {
    max_bytes: usize,
    queue: StdMutex<TerminalQueueState>,
    ready: Notify,
}

impl TerminalStreamInner {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes: max_bytes.max(1),
            queue: StdMutex::new(TerminalQueueState::default()),
            ready: Notify::new(),
        }
    }

    fn push(&self, event: TerminalEvent) {
        let size = event.approx_bytes();
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        if queue.closed {
            return;
        }
        queue.bytes += size;
        queue.events.push_back((size, event));
        while queue.bytes > self.max_bytes && queue.events.len() > 1 {
            if let Some((dropped, _)) = queue.events.pop_front() {
                queue.bytes -= dropped;
            }
        }
        drop(queue);
        self.ready.notify_one();
    }

    fn close(&self) {
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        queue.closed = true;
        drop(queue);
        self.ready.notify_waiters();
    }
}

/// Ordered, bounded stream of terminal events subscribed from a `Runtime`.
pub struct TerminalEventStream {
    inner: Arc<TerminalStreamInner>,
}

impl TerminalEventStream {
    /// Waits for at least one event and takes up to `max` in order, or returns
    /// an empty vector once the runtime has shut down and all queued events are drained.
    pub async fn next_batch(&self, max: usize) -> Vec<TerminalEvent> {
        let max = max.max(1);
        loop {
            let notified = self.inner.ready.notified();
            {
                let mut queue = self
                    .inner
                    .queue
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if !queue.events.is_empty() {
                    let count = max.min(queue.events.len());
                    let taken = queue.events.drain(..count).collect::<Vec<_>>();
                    queue.bytes -= taken.iter().map(|(size, _)| size).sum::<usize>();
                    return taken.into_iter().map(|(_, event)| event).collect();
                }
                if queue.closed {
                    return Vec::new();
                }
            }
            notified.await;
        }
    }
}

#[derive(Default)]
struct TerminalBusState {
    subscribers: Vec<std::sync::Weak<TerminalStreamInner>>,
    closed: bool,
}

#[derive(Clone, Default)]
pub(crate) struct TerminalEventBus {
    state: Arc<StdMutex<TerminalBusState>>,
}

impl TerminalEventBus {
    pub(crate) fn subscribe(&self, max_bytes: usize) -> TerminalEventStream {
        let inner = Arc::new(TerminalStreamInner::new(max_bytes));
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.closed {
            inner.close();
        } else {
            state.subscribers.retain(|sub| sub.strong_count() > 0);
            state.subscribers.push(Arc::downgrade(&inner));
        }
        TerminalEventStream { inner }
    }

    pub(crate) fn publish(&self, event: TerminalEvent) {
        let subscribers = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.closed {
                return;
            }
            let mut live = Vec::with_capacity(state.subscribers.len());
            state.subscribers.retain(|weak| {
                if let Some(sub) = weak.upgrade() {
                    live.push(sub);
                    true
                } else {
                    false
                }
            });
            live
        };
        let mut iter = subscribers.into_iter();
        if let Some(first) = iter.next() {
            for subscriber in iter {
                subscriber.push(event.clone());
            }
            first.push(event);
        }
    }

    pub(crate) fn close(&self) {
        let subscribers = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.closed = true;
            state
                .subscribers
                .drain(..)
                .filter_map(|weak| weak.upgrade())
                .collect::<Vec<_>>()
        };
        for subscriber in subscribers {
            subscriber.close();
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub project_id: String,
    pub title: String,
}

pub(crate) struct TerminalSession {
    id: String,
    project_id: String,
    title: String,
    owner: TerminalOwner,
    client: Arc<ServerClient>,
    task: JoinHandle<()>,
    ended: Arc<AtomicBool>,
    output_buffer: Arc<StdMutex<OutputRingBuffer>>,
    ws_subscribers: usize,
    disconnect_timer: Option<JoinHandle<()>>,
}

impl TerminalSession {
    pub(crate) async fn close(mut self) -> Result<(), String> {
        if let Some(timer) = self.disconnect_timer.take() {
            timer.abort();
        }
        self.ended.store(true, Ordering::Release);
        self.task.abort();
        self.client
            .request("terminal.close", json!({ "streamId": self.id }))
            .await
            .map(|_| ())
    }

    fn info(&self) -> TerminalInfo {
        TerminalInfo {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            title: self.title.clone(),
        }
    }
}

#[derive(Default)]
struct TerminalState {
    sessions: HashMap<String, TerminalSession>,
    device_connections: HashMap<String, usize>,
}

#[derive(Clone)]
pub struct TerminalManager {
    state: Arc<StdMutex<TerminalState>>,
    retention_duration: Arc<StdMutex<Duration>>,
    /// Serializes only short metadata/project-removal transitions without holding locks across RPCs.
    project_gate: Arc<AsyncMutex<()>>,
    #[cfg(test)]
    open_barrier: Arc<StdMutex<Option<Arc<tokio::sync::Barrier>>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            state: Arc::new(StdMutex::new(TerminalState::default())),
            retention_duration: Arc::new(StdMutex::new(TERMINAL_DISCONNECT_RETENTION)),
            project_gate: Arc::new(AsyncMutex::new(())),
            #[cfg(test)]
            open_barrier: Arc::new(StdMutex::new(None)),
        }
    }
}

impl TerminalManager {
    #[cfg(test)]
    pub(crate) fn set_disconnect_retention(&self, duration: Duration) {
        *self
            .retention_duration
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = duration;
    }

    #[cfg(test)]
    pub(crate) fn set_open_barrier(&self, barrier: Option<Arc<tokio::sync::Barrier>>) {
        *self
            .open_barrier
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = barrier;
    }

    #[cfg(test)]
    pub(crate) async fn wait_open_barrier(&self) {
        let barrier = self
            .open_barrier
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(barrier) = barrier {
            barrier.wait().await;
        }
    }

    #[cfg(test)]
    pub(crate) fn session_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sessions
            .len()
    }

    pub(crate) async fn start(
        &self,
        servers: Arc<ServerManager>,
        terminal_events: TerminalEventBus,
        project: &Project,
        cols: u16,
        rows: u16,
        owner: TerminalOwner,
    ) -> Result<(TerminalInfo, TerminalSession), String> {
        let client = servers.client(&project.connection).await?;
        let terminal_id = format!(
            "terminal-{}-{}",
            std::process::id(),
            TERMINAL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let mut events = client.subscribe(&terminal_id);
        let event_terminal_id = terminal_id.clone();
        let event_client = Arc::clone(&client);
        let state = Arc::clone(&self.state);
        let ended = Arc::new(AtomicBool::new(false));
        let event_ended = Arc::clone(&ended);
        let output_buffer = Arc::new(StdMutex::new(OutputRingBuffer::default()));
        let event_buffer = Arc::clone(&output_buffer);
        let task = tokio::spawn(async move {
            loop {
                let Some(event) = events.recv().await else {
                    terminal_events.publish(TerminalEvent::Error {
                        terminal_id: event_terminal_id.clone(),
                        message: "pilo-server terminal connection closed".to_owned(),
                    });
                    break;
                };
                if event.event == SERVER_DISCONNECTED_EVENT {
                    terminal_events.publish(TerminalEvent::Error {
                        terminal_id: event_terminal_id.clone(),
                        message: event
                            .data
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("pilo-server terminal connection closed")
                            .to_owned(),
                    });
                    if event.data.get("overflow").and_then(Value::as_bool) == Some(true) {
                        let _ = event_client
                            .request("terminal.close", json!({ "streamId": &event_terminal_id }))
                            .await;
                    }
                    break;
                }
                if event.stream_id != event_terminal_id {
                    continue;
                }
                match event.event.as_str() {
                    "terminal.output" => {
                        let data = event.binary.into_iter().next().unwrap_or_default();
                        event_buffer
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push(&data);
                        terminal_events.publish(TerminalEvent::Output {
                            terminal_id: event_terminal_id.clone(),
                            data,
                        });
                    }
                    "terminal.exit" => {
                        terminal_events.publish(TerminalEvent::Exit {
                            terminal_id: event_terminal_id.clone(),
                        });
                        break;
                    }
                    "terminal.error" => {
                        terminal_events.publish(TerminalEvent::Error {
                            terminal_id: event_terminal_id.clone(),
                            message: event
                                .data
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("terminal error")
                                .to_owned(),
                        });
                        break;
                    }
                    _ => {}
                }
            }
            event_ended.store(true, Ordering::Release);
            if let Some(mut removed) = state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .sessions
                .remove(&event_terminal_id)
                && let Some(timer) = removed.disconnect_timer.take()
            {
                timer.abort();
            }
        });
        if let Err(error) = client
            .request(
                "terminal.open",
                json!({
                    "streamId": terminal_id,
                    "project": project.path,
                    "cols": cols,
                    "rows": rows,
                }),
            )
            .await
        {
            ended.store(true, Ordering::Release);
            task.abort();
            return Err(error);
        }
        let info = TerminalInfo {
            id: terminal_id.clone(),
            project_id: project.id.clone(),
            title: project.name.clone(),
        };
        let session = TerminalSession {
            id: terminal_id,
            project_id: project.id.clone(),
            title: project.name.clone(),
            owner,
            client,
            task,
            ended,
            output_buffer,
            ws_subscribers: 0,
            disconnect_timer: None,
        };
        Ok((info, session))
    }

    /// Commits a started terminal if `check` succeeds; returns the session back for closing on error.
    pub(crate) async fn commit_if<F, E>(
        &self,
        mut session: TerminalSession,
        check: F,
    ) -> Result<(), (E, Box<TerminalSession>)>
    where
        F: FnOnce() -> Result<(), E>,
    {
        let _gate = self.project_gate.lock().await;
        if let Err(error) = check() {
            return Err((error, Box::new(session)));
        }
        let retention = *self
            .retention_duration
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let has_ws_connection = match &session.owner {
            TerminalOwner::Local => true,
            TerminalOwner::Device(device_id) => {
                state
                    .device_connections
                    .get(device_id)
                    .copied()
                    .unwrap_or(0)
                    > 0
            }
        };
        if !session.ended.load(Ordering::Acquire) {
            if !has_ws_connection {
                session.disconnect_timer = Some(Self::spawn_disconnect_timer(
                    Arc::clone(&self.state),
                    session.id.clone(),
                    retention,
                ));
            }
            state.sessions.insert(session.id.clone(), session);
        }
        Ok(())
    }

    pub async fn write(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalAccessError> {
        let client = {
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let session = state.sessions.get(terminal_id).ok_or_else(|| {
                TerminalAccessError::NotFound(format!("terminal '{terminal_id}' is not running"))
            })?;
            if &session.owner != owner {
                return Err(TerminalAccessError::Forbidden(format!(
                    "terminal '{terminal_id}' is owned by another principal"
                )));
            }
            Arc::clone(&session.client)
        };
        client
            .request_with_binary(
                "terminal.write",
                json!({ "streamId": terminal_id }),
                vec![data.to_vec()],
            )
            .await
            .map(|_| ())
            .map_err(TerminalAccessError::Internal)
    }

    pub async fn resize(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalAccessError> {
        let client = {
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let session = state.sessions.get(terminal_id).ok_or_else(|| {
                TerminalAccessError::NotFound(format!("terminal '{terminal_id}' is not running"))
            })?;
            if &session.owner != owner {
                return Err(TerminalAccessError::Forbidden(format!(
                    "terminal '{terminal_id}' is owned by another principal"
                )));
            }
            Arc::clone(&session.client)
        };
        client
            .request(
                "terminal.resize",
                json!({ "streamId": terminal_id, "cols": cols, "rows": rows }),
            )
            .await
            .map(|_| ())
            .map_err(TerminalAccessError::Internal)
    }

    pub async fn close(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
    ) -> Result<(), TerminalAccessError> {
        let session = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            match state.sessions.get(terminal_id) {
                None => return Ok(()),
                Some(session) if &session.owner != owner => {
                    return Err(TerminalAccessError::Forbidden(format!(
                        "terminal '{terminal_id}' is owned by another principal"
                    )));
                }
                Some(_) => state.sessions.remove(terminal_id),
            }
        };
        if let Some(session) = session {
            session
                .close()
                .await
                .map_err(TerminalAccessError::Internal)?;
        }
        Ok(())
    }

    /// Verifies terminal ownership for HTTP `terminal.attach`.
    /// Only cancels a disconnect retention timer when at least one v2 WS is subscribed to this terminal.
    pub fn attach(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
    ) -> Result<TerminalInfo, TerminalAccessError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let session = state.sessions.get_mut(terminal_id).ok_or_else(|| {
            TerminalAccessError::NotFound(format!("terminal '{terminal_id}' is not running"))
        })?;
        if &session.owner != owner {
            return Err(TerminalAccessError::Forbidden(format!(
                "terminal '{terminal_id}' is owned by another principal"
            )));
        }
        if session.ws_subscribers > 0
            && let Some(timer) = session.disconnect_timer.take()
        {
            timer.abort();
        }
        Ok(session.info())
    }

    pub(crate) fn subscribe_ws(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
    ) -> Result<TerminalInfo, TerminalAccessError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let session = state.sessions.get_mut(terminal_id).ok_or_else(|| {
            TerminalAccessError::NotFound(format!("terminal '{terminal_id}' is not running"))
        })?;
        if &session.owner != owner {
            return Err(TerminalAccessError::Forbidden(format!(
                "terminal '{terminal_id}' is owned by another principal"
            )));
        }
        session.ws_subscribers += 1;
        if let Some(timer) = session.disconnect_timer.take() {
            timer.abort();
        }
        Ok(session.info())
    }

    pub(crate) fn unsubscribe_ws(&self, owner: &TerminalOwner, terminal_id: &str) {
        let retention = *self
            .retention_duration
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let has_ws = match owner {
            TerminalOwner::Local => true,
            TerminalOwner::Device(device_id) => {
                state
                    .device_connections
                    .get(device_id)
                    .copied()
                    .unwrap_or(0)
                    > 0
            }
        };
        let Some(session) = state.sessions.get_mut(terminal_id) else {
            return;
        };
        if &session.owner != owner {
            return;
        }
        session.ws_subscribers = session.ws_subscribers.saturating_sub(1);
        if session.ws_subscribers == 0 && !has_ws && session.disconnect_timer.is_none() {
            session.disconnect_timer = Some(Self::spawn_disconnect_timer(
                Arc::clone(&self.state),
                terminal_id.to_owned(),
                retention,
            ));
        }
    }

    pub fn snapshot(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
    ) -> Result<TerminalSnapshot, TerminalAccessError> {
        let buffer = {
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let session = state.sessions.get(terminal_id).ok_or_else(|| {
                TerminalAccessError::NotFound(format!("terminal '{terminal_id}' is not running"))
            })?;
            if &session.owner != owner {
                return Err(TerminalAccessError::Forbidden(format!(
                    "terminal '{terminal_id}' is owned by another principal"
                )));
            }
            Arc::clone(&session.output_buffer)
        };
        let bytes = buffer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .snapshot();
        Ok(TerminalSnapshot {
            terminal_id: terminal_id.to_owned(),
            data: BASE64.encode(bytes),
        })
    }

    #[cfg(test)]
    pub(crate) fn owns(&self, owner: &TerminalOwner, terminal_id: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sessions
            .get(terminal_id)
            .is_some_and(|session| &session.owner == owner)
    }

    pub(crate) fn on_device_ws_connected(&self, device_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        *state
            .device_connections
            .entry(device_id.to_owned())
            .or_insert(0) += 1;
    }

    pub(crate) fn on_device_ws_disconnected<'a>(
        &self,
        device_id: &str,
        subscribed_terminals: impl IntoIterator<Item = &'a str>,
    ) {
        let retention = *self
            .retention_duration
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let owner = TerminalOwner::Device(device_id.to_owned());
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        for terminal_id in subscribed_terminals {
            if let Some(session) = state.sessions.get_mut(terminal_id)
                && session.owner == owner
            {
                session.ws_subscribers = session.ws_subscribers.saturating_sub(1);
            }
        }
        let remaining = match state.device_connections.get_mut(device_id) {
            Some(count) if *count > 1 => {
                *count -= 1;
                *count
            }
            Some(_) => {
                state.device_connections.remove(device_id);
                0
            }
            None => 0,
        };
        if remaining > 0 {
            return;
        }
        for (terminal_id, session) in state.sessions.iter_mut() {
            if session.owner != owner || session.disconnect_timer.is_some() {
                continue;
            }
            session.disconnect_timer = Some(Self::spawn_disconnect_timer(
                Arc::clone(&self.state),
                terminal_id.clone(),
                retention,
            ));
        }
    }

    fn spawn_disconnect_timer(
        state_mutex: Arc<StdMutex<TerminalState>>,
        id: String,
        retention: Duration,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            tokio::time::sleep(retention).await;
            let removed = state_mutex
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .sessions
                .remove(&id);
            if let Some(mut session) = removed {
                // Detach self handle so close() does not abort the currently running timer task.
                session.disconnect_timer = None;
                log::info!(target: "terminal", "closing disconnected remote terminal {id} after retention timeout");
                if let Err(error) = session.close().await {
                    log::warn!(target: "terminal", "failed to close expired remote terminal {id}: {error}");
                }
            }
        })
    }

    pub(crate) async fn close_by_device(&self, device_id: &str) {
        let owner = TerminalOwner::Device(device_id.to_owned());
        self.close_matching(|session| session.owner == owner).await;
    }

    pub(crate) async fn close_all_remote(&self) {
        self.close_matching(|session| matches!(session.owner, TerminalOwner::Device(_)))
            .await;
    }

    async fn close_matching(&self, predicate: impl Fn(&TerminalSession) -> bool) {
        let taken = {
            let _gate = self.project_gate.lock().await;
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let ids = state
                .sessions
                .iter()
                .filter(|(_, session)| predicate(session))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| state.sessions.remove(&id))
                .collect::<Vec<_>>()
        };
        let mut tasks = tokio::task::JoinSet::new();
        for session in taken {
            tasks.spawn(async move {
                let id = session.id.clone();
                if let Err(error) = session.close().await {
                    log::warn!(target: "terminal", "failed to close terminal {id}: {error}");
                }
            });
        }
        while tasks.join_next().await.is_some() {}
    }

    /// Runs `remove_project` serialized with terminal commits, then closes taken sessions outside locks.
    pub(crate) async fn remove_project_and_close<T, F>(
        &self,
        project_id: &str,
        remove_project: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let (result, taken) = {
            let _gate = self.project_gate.lock().await;
            let result = remove_project()?;
            let taken = {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                let ids = state
                    .sessions
                    .iter()
                    .filter(|(_, session)| session.project_id == project_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| state.sessions.remove(&id))
                    .collect::<Vec<_>>()
            };
            (result, taken)
        };
        for session in taken {
            let id = session.id.clone();
            if let Err(error) = session.close().await {
                log::warn!(target: "terminal", "failed to close terminal {id} for removed project: {error}");
            }
        }
        Ok(result)
    }

    pub async fn close_all(&self) {
        let taken = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        let mut tasks = tokio::task::JoinSet::new();
        for session in taken {
            tasks.spawn(async move {
                let _ = session.close().await;
            });
        }
        while tasks.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminal_stream_preserves_bytes_order_and_closes_cleanly() {
        let bus = TerminalEventBus::default();
        let stream = bus.subscribe(TERMINAL_QUEUE_MAX_BYTES);
        let expected = vec![
            TerminalEvent::Output {
                terminal_id: "t".into(),
                data: vec![0, 255, 10],
            },
            TerminalEvent::Output {
                terminal_id: "t".into(),
                data: vec![],
            },
            TerminalEvent::Exit {
                terminal_id: "t".into(),
            },
            TerminalEvent::Error {
                terminal_id: "t".into(),
                message: "closed".into(),
            },
        ];
        for event in &expected {
            bus.publish(event.clone());
        }
        assert_eq!(stream.next_batch(2).await, expected[..2]);
        bus.close();
        assert_eq!(stream.next_batch(10).await, expected[2..]);
        assert!(stream.next_batch(10).await.is_empty());
    }

    #[tokio::test]
    async fn terminal_stream_evicts_oldest_events_above_byte_limit() {
        let bus = TerminalEventBus::default();
        let stream = bus.subscribe(160);
        bus.publish(TerminalEvent::Output {
            terminal_id: "t".into(),
            data: vec![1; 100],
        });
        bus.publish(TerminalEvent::Output {
            terminal_id: "t".into(),
            data: vec![2; 100],
        });
        assert_eq!(
            stream.next_batch(10).await,
            vec![TerminalEvent::Output {
                terminal_id: "t".into(),
                data: vec![2; 100],
            }]
        );
    }

    #[tokio::test]
    async fn terminal_stream_close_wakes_pending_waiter() {
        let bus = TerminalEventBus::default();
        let stream = bus.subscribe(TERMINAL_QUEUE_MAX_BYTES);
        let waiter = tokio::spawn(async move { stream.next_batch(16).await });
        tokio::task::yield_now().await;
        bus.close();
        assert!(waiter.await.unwrap().is_empty());
    }

    #[test]
    fn output_ring_buffer_keeps_latest_64_kib() {
        let mut buffer = OutputRingBuffer::default();
        buffer.push(&vec![b'a'; TERMINAL_SNAPSHOT_MAX_BYTES - 4]);
        buffer.push(b"12345678");
        let snapshot = buffer.snapshot();
        assert_eq!(snapshot.len(), TERMINAL_SNAPSHOT_MAX_BYTES);
        assert!(snapshot.ends_with(b"12345678"));
        assert_eq!(snapshot[0], b'a');

        let mut oversize = vec![b'x'; TERMINAL_SNAPSHOT_MAX_BYTES + 128];
        oversize.extend_from_slice(b"tail");
        buffer.push(&oversize);
        let snapshot = buffer.snapshot();
        assert_eq!(snapshot.len(), TERMINAL_SNAPSHOT_MAX_BYTES);
        assert!(snapshot.ends_with(b"tail"));
    }
}
