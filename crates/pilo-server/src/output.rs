use std::sync::{Arc, Mutex};

use pilo_protocol::{Envelope, encode_frame};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

const OUTPUT_MAX_BYTES: usize = 64 * 1024 * 1024;

pub(crate) struct QueuedOutput {
    pub(crate) frame: Vec<u8>,
    pub(crate) _bytes: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub(crate) struct ServerWriter {
    sender: Arc<Mutex<Option<mpsc::Sender<QueuedOutput>>>>,
    bytes: Arc<Semaphore>,
    runtime: tokio::runtime::Handle,
    retain_pi: bool,
}

impl ServerWriter {
    pub(crate) fn new(retain_pi: bool) -> Self {
        Self {
            sender: Arc::new(Mutex::new(None)),
            bytes: Arc::new(Semaphore::new(OUTPUT_MAX_BYTES)),
            runtime: tokio::runtime::Handle::current(),
            retain_pi,
        }
    }

    pub(crate) fn set_sender(&self, sender: Option<mpsc::Sender<QueuedOutput>>) {
        *self
            .sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sender;
    }

    pub(crate) fn for_connection(&self, sender: mpsc::Sender<QueuedOutput>) -> Self {
        Self {
            sender: Arc::new(Mutex::new(Some(sender))),
            bytes: Arc::clone(&self.bytes),
            runtime: self.runtime.clone(),
            retain_pi: false,
        }
    }

    pub(crate) async fn send(&self, message: Envelope) -> Result<(), String> {
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let retain_stream = self.retain_pi
            && matches!(&message, Envelope::Event { event, .. } if event.starts_with("pi."));
        let Some(sender) = sender else {
            return if retain_stream {
                Ok(())
            } else {
                Err("server output is closed".to_owned())
            };
        };
        let response_id = match &message {
            Envelope::Response { id, .. } => Some(*id),
            _ => None,
        };
        let binary_bytes = match &message {
            Envelope::Request { binary, .. }
            | Envelope::Response { binary, .. }
            | Envelope::Event { binary, .. } => binary
                .iter()
                .fold(0_usize, |sum, payload| sum.saturating_add(payload.len())),
        };
        let frame = if binary_bytes > OUTPUT_MAX_BYTES {
            None
        } else {
            match encode_frame(message) {
                Ok(frame) if frame.len() <= OUTPUT_MAX_BYTES => Some(frame),
                Ok(_) => None,
                Err(_) => None,
            }
        };
        let frame = match frame {
            Some(frame) => frame,
            None => {
                if let Some(id) = response_id {
                    encode_frame(Envelope::error(
                        id,
                        "output_too_large",
                        "server output exceeds the byte budget",
                    ))
                    .map_err(|error| error.to_string())?
                } else {
                    return Err("server output exceeds the byte budget".to_owned());
                }
            }
        };
        let bytes = frame.len().max(1);
        // Reserve a queue slot first: waiting producers must not retain byte permits.
        let slot = match sender.reserve().await {
            Ok(slot) => slot,
            Err(_) if retain_stream => return Ok(()),
            Err(_) => return Err("server output is closed".to_owned()),
        };
        let permit = Arc::clone(&self.bytes)
            .acquire_many_owned(bytes as u32)
            .await
            .map_err(|_| "server output is closed".to_owned())?;
        slot.send(QueuedOutput {
            frame,
            _bytes: permit,
        });
        Ok(())
    }

    pub(crate) fn blocking_send(&self, message: Envelope) -> Result<(), String> {
        self.runtime.block_on(self.send(message))
    }
}
