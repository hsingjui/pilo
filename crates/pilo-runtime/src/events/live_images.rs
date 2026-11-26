use std::{collections::VecDeque, sync::Arc};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD},
};
use serde_json::Value;

use super::LiveUserImage;

pub(crate) const LIVE_IMAGE_PREFIX: &str = "live:";
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGE_BASE64_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_CACHED_BYTES: usize = 64 * 1024 * 1024;
const MAX_CACHED_IMAGES: usize = 128;

struct CachedImage {
    project_id: String,
    session_key: String,
    id: String,
    data: Arc<String>,
}

/// Pi already supplies the resized image in `message_start`. Keep only its
/// descriptor in the event log and snapshots; temporary chats have no JSONL.
#[derive(Default)]
pub(super) struct LiveImages {
    images: VecDeque<CachedImage>,
    bytes: usize,
}

impl LiveImages {
    pub(super) fn remember(
        &mut self,
        project_id: &str,
        session_key: &str,
        content: Vec<Value>,
    ) -> Vec<LiveUserImage> {
        let mut nonce = [0; 16];
        if getrandom::fill(&mut nonce).is_err() {
            return Vec::new();
        }
        let message_id = URL_SAFE_NO_PAD.encode(nonce);
        let mut descriptors = Vec::new();
        for (index, mut block) in content.into_iter().enumerate() {
            if block["type"] != "image" {
                continue;
            }
            let Some(mime_type) = block["mimeType"].as_str().map(str::to_owned) else {
                continue;
            };
            let Value::String(data) = block["data"].take() else {
                continue;
            };
            if data.is_empty() || data.len() > MAX_IMAGE_BASE64_BYTES {
                continue;
            }
            while self.images.len() >= MAX_CACHED_IMAGES
                || self.bytes + data.len() > MAX_CACHED_BYTES
            {
                let Some(oldest) = self.images.pop_front() else {
                    break;
                };
                self.bytes -= oldest.data.len();
            }
            let id = format!("{LIVE_IMAGE_PREFIX}{message_id}:{index}");
            self.bytes += data.len();
            self.images.push_back(CachedImage {
                project_id: project_id.to_owned(),
                session_key: session_key.to_owned(),
                id: id.clone(),
                data: Arc::new(data),
            });
            descriptors.push(LiveUserImage { id, mime_type });
        }
        descriptors
    }

    pub(super) fn get(&self, project_id: &str, session_key: &str, id: &str) -> Option<Arc<String>> {
        self.images
            .iter()
            .rev()
            .find(|image| {
                image.id == id && image.project_id == project_id && image.session_key == session_key
            })
            .map(|image| Arc::clone(&image.data))
    }
}

pub(super) fn decode(data: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(data)
        .or_else(|_| STANDARD_NO_PAD.decode(data))
        .map_err(|error| format!("failed to decode live chat image: {error}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image exceeds chat size limit".to_owned());
    }
    Ok(bytes)
}
