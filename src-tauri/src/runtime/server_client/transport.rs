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
    sync::{Mutex, broadcast, mpsc, oneshot},
    task::JoinHandle,
};

const STREAM_EVENT_CAPACITY: usize = 512;
pub const SERVER_DISCONNECTED_EVENT: &str = "server.disconnected";

pub(super) struct ServerResponse {
    pub(super) value: Value,
    pub(super) binary: Vec<Vec<u8>>,
}

pub(super) struct PendingRequest {
    pub(super) reply: oneshot::Sender<Result<ServerResponse, String>>,
}

pub(super) type PendingRequests = Arc<Mutex<HashMap<u64, PendingRequest>>>;

#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub stream_id: String,
    pub event: String,
    pub data: Value,
    pub binary: Vec<Vec<u8>>,
}

#[derive(Default)]
pub(super) struct ServerEventHub {
    streams: StdMutex<HashMap<String, broadcast::Sender<Arc<ServerEvent>>>>,
}

impl ServerEventHub {
    pub(super) fn subscribe(&self, stream_id: &str) -> broadcast::Receiver<Arc<ServerEvent>> {
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        streams.retain(|_, sender| sender.receiver_count() > 0);
        streams
            .entry(stream_id.to_owned())
            .or_insert_with(|| broadcast::channel(STREAM_EVENT_CAPACITY).0)
            .subscribe()
    }

    pub(super) fn send(&self, event: ServerEvent) {
        let sender = {
            let mut streams = self
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(sender) = streams.get(&event.stream_id).cloned() else {
                return;
            };
            if sender.receiver_count() == 0 {
                streams.remove(&event.stream_id);
                return;
            }
            sender
        };
        let _ = sender.send(Arc::new(event));
    }

    fn disconnect(&self, message: String) {
        let event = Arc::new(ServerEvent {
            stream_id: String::new(),
            event: SERVER_DISCONNECTED_EVENT.to_owned(),
            data: json!({ "message": message }),
            binary: Vec::new(),
        });
        let senders = {
            let mut streams = self
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            streams.retain(|_, sender| sender.receiver_count() > 0);
            streams.values().cloned().collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(event.clone());
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
    events.disconnect(message.clone());
    fail_pending(pending, &message).await;
}

pub(super) async fn fail_pending(pending: &PendingRequests, message: &str) {
    let mut pending = pending.lock().await;
    for (_, pending) in pending.drain() {
        let _ = pending.reply.send(Err(message.to_owned()));
    }
}
