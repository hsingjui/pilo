use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex as StdMutex, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    task::JoinHandle,
};

use pilo_domain::Project;

use super::server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager};

static TERMINAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Maximum buffered terminal payload kept per subscriber before dropping the oldest event.
pub const TERMINAL_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;

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
    client: Arc<ServerClient>,
    task: JoinHandle<()>,
    ended: Arc<AtomicBool>,
}

impl TerminalSession {
    pub(crate) async fn close(self) -> Result<(), String> {
        self.ended.store(true, Ordering::Release);
        self.task.abort();
        self.client
            .request("terminal.close", json!({ "streamId": self.id }))
            .await
            .map(|_| ())
    }
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<StdMutex<HashMap<String, TerminalSession>>>,
    /// Serializes only short metadata/project-removal transitions without holding locks across RPCs.
    project_gate: AsyncMutex<()>,
}

impl TerminalManager {
    pub(crate) async fn start(
        &self,
        servers: Arc<ServerManager>,
        terminal_events: TerminalEventBus,
        project: &Project,
        cols: u16,
        rows: u16,
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
        let sessions = Arc::clone(&self.sessions);
        let ended = Arc::new(AtomicBool::new(false));
        let event_ended = Arc::clone(&ended);
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
            sessions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&event_terminal_id);
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
            client,
            task,
            ended,
        };
        Ok((info, session))
    }

    /// Commits a started terminal if `check` succeeds; returns the session back for closing on error.
    pub(crate) async fn commit_if<F>(
        &self,
        session: TerminalSession,
        check: F,
    ) -> Result<(), (String, TerminalSession)>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let _gate = self.project_gate.lock().await;
        if let Err(error) = check() {
            return Err((error, session));
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        if !session.ended.load(Ordering::Acquire) {
            sessions.insert(session.id.clone(), session);
        }
        Ok(())
    }

    pub async fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let client = {
            let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
            sessions
                .get(terminal_id)
                .map(|session| Arc::clone(&session.client))
                .ok_or_else(|| format!("terminal '{terminal_id}' is not running"))?
        };
        client
            .request_with_binary(
                "terminal.write",
                json!({ "streamId": terminal_id }),
                vec![data.to_vec()],
            )
            .await
            .map(|_| ())
    }

    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let client = {
            let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
            sessions
                .get(terminal_id)
                .map(|session| Arc::clone(&session.client))
                .ok_or_else(|| format!("terminal '{terminal_id}' is not running"))?
        };
        client
            .request(
                "terminal.resize",
                json!({ "streamId": terminal_id, "cols": cols, "rows": rows }),
            )
            .await
            .map(|_| ())
    }

    pub async fn close(&self, terminal_id: &str) -> Result<(), String> {
        let Some(session) = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(terminal_id)
        else {
            return Ok(());
        };
        session.close().await
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
                let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
                let ids = sessions
                    .iter()
                    .filter(|(_, session)| session.project_id == project_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| sessions.remove(&id))
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
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
}
