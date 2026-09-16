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
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};

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
    streams: StdMutex<HashMap<String, mpsc::UnboundedSender<ServerEvent>>>,
}

impl ServerEventHub {
    pub(super) fn subscribe(&self, stream_id: &str) -> mpsc::UnboundedReceiver<ServerEvent> {
        // The protocol has one shared stdout reader for every logical stream. This
        // mailbox is intentionally unbounded so a slow consumer cannot apply
        // head-of-line backpressure to unrelated streams. Pi runtime events are
        // coalesced after semantic adaptation before they cross into the WebView.
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        streams.retain(|_, sender| !sender.is_closed());
        // A server stream has exactly one owner in the desktop runtime. Replacing
        // an existing sender closes the stale receiver instead of broadcasting
        // duplicate events to multiple consumers.
        streams.insert(stream_id.to_owned(), sender);
        receiver
    }

    pub(super) fn send(&self, event: ServerEvent) {
        let stream_id = event.stream_id.clone();
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(sender) = streams.get(&stream_id) else {
            return;
        };
        if sender.send(event).is_err() {
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
            streams.retain(|_, sender| !sender.is_closed());
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
