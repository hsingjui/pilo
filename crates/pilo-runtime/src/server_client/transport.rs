use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
};

use pilo_protocol::{Envelope, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::{
    io::BufReader,
    process::{Child, ChildStdin, ChildStdout},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    task::JoinHandle,
};

const STREAM_EVENT_BUFFER_CAPACITY: usize = 2_048;
const STREAM_EVENT_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const SERVER_DISCONNECTED_EVENT: &str = "server.disconnected";

pub(super) struct ServerResponse {
    pub(super) value: Value,
    pub(super) binary: Vec<Vec<u8>>,
}

pub(super) struct PendingRequest {
    pub(super) reply: oneshot::Sender<Result<ServerResponse, String>>,
}

pub(super) type PendingRequests = Arc<Mutex<HashMap<u64, PendingRequest>>>;

pub(super) struct PendingRequestGuard {
    pub(super) pending: PendingRequests,
    pub(super) id: u64,
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        // A caller can be cancelled while enqueueing, before the reply timeout
        // starts. Remove its sender even when no response will ever arrive.
        if let Ok(mut pending) = self.pending.try_lock() {
            pending.remove(&self.id);
        } else if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let pending = Arc::clone(&self.pending);
            let id = self.id;
            runtime.spawn(async move {
                pending.lock().await.remove(&id);
            });
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub stream_id: String,
    pub event: String,
    pub data: Value,
    pub binary: Vec<Vec<u8>>,
}

struct QueuedServerEvent {
    event: ServerEvent,
    _bytes: Option<OwnedSemaphorePermit>,
}

pub struct ServerEventReceiver {
    receiver: mpsc::Receiver<QueuedServerEvent>,
}

impl ServerEventReceiver {
    pub async fn recv(&mut self) -> Option<ServerEvent> {
        self.receiver.recv().await.map(|queued| queued.event)
    }

    #[cfg(test)]
    pub fn try_recv(&mut self) -> Result<ServerEvent, mpsc::error::TryRecvError> {
        self.receiver.try_recv().map(|queued| queued.event)
    }
}

struct StreamQueue {
    sender: mpsc::Sender<QueuedServerEvent>,
    bytes: Arc<Semaphore>,
}

#[derive(Default)]
pub(super) struct ServerEventHub {
    streams: StdMutex<HashMap<String, StreamQueue>>,
}

impl ServerEventHub {
    pub(super) fn subscribe(&self, stream_id: &str) -> ServerEventReceiver {
        // Keep one slot for a terminal control event. A slow consumer can therefore
        // be disconnected without allowing an unbounded queue to retain terminal
        // output or Pi payloads indefinitely.
        let (sender, receiver) = mpsc::channel(STREAM_EVENT_BUFFER_CAPACITY + 1);
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        streams.retain(|_, queue| !queue.sender.is_closed());
        // A server stream has exactly one owner in the desktop runtime. Replacing
        // an existing sender closes the stale receiver instead of broadcasting
        // duplicate events to multiple consumers.
        streams.insert(
            stream_id.to_owned(),
            StreamQueue {
                sender,
                bytes: Arc::new(Semaphore::new(STREAM_EVENT_MAX_BYTES)),
            },
        );
        ServerEventReceiver { receiver }
    }

    pub(super) fn send(&self, event: ServerEvent) {
        let stream_id = event.stream_id.clone();
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(queue) = streams.get(&stream_id) else {
            return;
        };
        let mut size = crate::events::PayloadSize::default();
        let json_bytes = if serde_json::to_writer(&mut size, &event.data).is_ok() {
            size.0
        } else {
            usize::MAX
        };
        let bytes = event.binary.iter().fold(
            json_bytes
                .saturating_add(event.stream_id.len())
                .saturating_add(event.event.len()),
            |sum, payload| sum.saturating_add(payload.len()),
        );
        let permit = u32::try_from(bytes)
            .ok()
            .and_then(|bytes| Arc::clone(&queue.bytes).try_acquire_many_owned(bytes).ok());
        if queue.sender.capacity() <= 1 || permit.is_none() {
            log::warn!(target: "pilo-server", "event stream overflow streamId={stream_id} event={} payloadBytes={bytes} queueCapacity={} availableBytes={}", event.event, queue.sender.capacity(), queue.bytes.available_permits());
            let _ = queue.sender.try_send(QueuedServerEvent {
                event: ServerEvent {
                    stream_id: stream_id.clone(),
                    event: SERVER_DISCONNECTED_EVENT.to_owned(),
                    data: json!({
                        "message": "server event stream overflowed",
                        "overflow": true,
                    }),
                    binary: Vec::new(),
                },
                _bytes: None,
            });
            streams.remove(&stream_id);
            return;
        }
        if queue
            .sender
            .try_send(QueuedServerEvent {
                event,
                _bytes: permit,
            })
            .is_err()
        {
            streams.remove(&stream_id);
        }
    }

    fn disconnect(&self, message: String) {
        let event = ServerEvent {
            stream_id: String::new(),
            event: SERVER_DISCONNECTED_EVENT.to_owned(),
            data: json!({ "message": message }),
            binary: Vec::new(),
        };
        let senders = {
            let mut streams = self
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            streams.retain(|_, queue| !queue.sender.is_closed());
            std::mem::take(&mut *streams)
                .into_values()
                .collect::<Vec<_>>()
        };
        log::warn!(target: "pilo-server", "disconnect notifying streams={} reason={message}", senders.len());
        for queue in senders {
            let _ = queue.sender.try_send(QueuedServerEvent {
                event: event.clone(),
                _bytes: None,
            });
        }
    }
}

pub(super) struct ServerProcess {
    pub(super) child: Child,
    pub(super) writer_task: JoinHandle<()>,
    pub(super) reader_task: JoinHandle<()>,
}

pub(super) async fn writer_loop(
    mut stdin: ChildStdin,
    mut requests: mpsc::Receiver<Envelope>,
    pending: PendingRequests,
    events: Arc<ServerEventHub>,
    closed: Arc<AtomicBool>,
) {
    while let Some(request) = requests.recv().await {
        let request_id = match &request {
            Envelope::Request { id, .. } => Some(*id),
            _ => None,
        };
        if let Err(error) = write_frame(&mut stdin, request).await {
            if matches!(
                error.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData
            ) {
                if let Some(id) = request_id
                    && let Some(pending) = pending.lock().await.remove(&id)
                {
                    let _ = pending
                        .reply
                        .send(Err(format!("pilo-server request is invalid: {error}")));
                }
                continue;
            }
            mark_disconnected(
                &pending,
                &events,
                &closed,
                format!("pilo-server write failed: {error}"),
            )
            .await;
            break;
        }
    }
}

pub(super) async fn reader_loop(
    mut stdout: BufReader<ChildStdout>,
    pending: PendingRequests,
    events: Arc<ServerEventHub>,
    closed: Arc<AtomicBool>,
) {
    let reason = loop {
        match read_frame(&mut stdout).await {
            Ok(Some(Envelope::Response {
                id,
                result,
                binary,
                error,
            })) => {
                if let Some(pending) = pending.lock().await.remove(&id) {
                    let response = match error {
                        Some(error) => Err(error.message),
                        None => Ok(ServerResponse {
                            value: result.unwrap_or(Value::Null),
                            binary,
                        }),
                    };
                    let _ = pending.reply.send(response);
                } else {
                    log::warn!(target: "pilo-server", "late or unclaimed response requestId={id}");
                }
            }
            Ok(Some(Envelope::Event {
                stream_id,
                event,
                data,
                binary,
            })) => {
                events.send(ServerEvent {
                    stream_id,
                    event,
                    data,
                    binary,
                });
            }
            Ok(Some(Envelope::Request { .. })) => {}
            Ok(None) => break "pilo-server disconnected".to_owned(),
            Err(error) => break format!("pilo-server protocol read failed: {error}"),
        }
    };
    mark_disconnected(&pending, &events, &closed, reason).await;
}

pub(super) async fn mark_disconnected(
    pending: &PendingRequests,
    events: &ServerEventHub,
    closed: &AtomicBool,
    message: String,
) {
    if closed.swap(true, Ordering::AcqRel) {
        return;
    }
    let pending_count = pending.lock().await.len();
    log::warn!(target: "pilo-server", "transport disconnected pendingRequests={pending_count} reason={message}");
    events.disconnect(message.clone());
    fail_pending(pending, &message).await;
}

pub(super) async fn fail_pending(pending: &PendingRequests, message: &str) {
    let mut pending = pending.lock().await;
    for (_, pending) in pending.drain() {
        let _ = pending.reply.send(Err(message.to_owned()));
    }
}
