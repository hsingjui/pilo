use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RpcCodecError {
    #[error("invalid RPC JSON frame: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("RPC stream ended with {buffered_bytes} byte(s) without an LF delimiter")]
    UnterminatedFrame { buffered_bytes: usize },
}

#[derive(Debug, Default)]
pub struct JsonlCodec {
    buffer: Vec<u8>,
}

impl JsonlCodec {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Result<Value, RpcCodecError>> {
        self.buffer.extend_from_slice(chunk);

        let mut frames = Vec::new();
        let mut start = 0;

        while let Some(relative_end) = self.buffer[start..].iter().position(|byte| *byte == b'\n') {
            let end = start + relative_end;
            let mut frame = &self.buffer[start..end];
            if frame.last() == Some(&b'\r') {
                frame = &frame[..frame.len() - 1];
            }

            frames.push(serde_json::from_slice(frame).map_err(RpcCodecError::from));
            start = end + 1;
        }

        if start > 0 {
            self.buffer.drain(..start);
        }

        frames
    }

    #[cfg(test)]
    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn finish(&self) -> Result<(), RpcCodecError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(RpcCodecError::UnterminatedFrame {
                buffered_bytes: self.buffer.len(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_only_on_lf() {
        let mut codec = JsonlCodec::new();
        let input = "{\"text\":\"left\u{2028}right\"}\n{\"value\":2}\n";
        let frames = codec.push(input.as_bytes());

        assert_eq!(frames.len(), 2);
        assert_eq!(
            frames[0].as_ref().unwrap(),
            &serde_json::json!({ "text": "left\u{2028}right" })
        );
        assert_eq!(
            frames[1].as_ref().unwrap(),
            &serde_json::json!({ "value": 2 })
        );
        assert_eq!(codec.buffered_len(), 0);
    }

    #[test]
    fn accepts_crlf_by_stripping_only_trailing_cr() {
        let mut codec = JsonlCodec::new();
        let frames = codec.push(b"{\"ok\":true}\r\n");

        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].as_ref().unwrap(),
            &serde_json::json!({ "ok": true })
        );
    }

    #[test]
    fn keeps_unterminated_tail_buffered_across_chunks() {
        let mut codec = JsonlCodec::new();

        assert!(codec.push(b"{\"text\":\"hel").is_empty());
        assert_eq!(codec.buffered_len(), 12);
        assert!(codec.push(b"lo\"}").is_empty());
        assert!(matches!(
            codec.finish(),
            Err(RpcCodecError::UnterminatedFrame { .. })
        ));

        let frames = codec.push(b"\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].as_ref().unwrap(),
            &serde_json::json!({ "text": "hello" })
        );
        assert!(codec.finish().is_ok());
    }

    #[test]
    fn reports_invalid_json_per_complete_frame() {
        let mut codec = JsonlCodec::new();
        let frames = codec.push(b"not-json\n{\"ok\":true}\n");

        assert!(matches!(frames[0], Err(RpcCodecError::InvalidJson(_))));
        assert_eq!(
            frames[1].as_ref().unwrap(),
            &serde_json::json!({ "ok": true })
        );
    }
}
