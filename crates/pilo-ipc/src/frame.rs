//! Frames are a 4-byte big-endian length followed by that many UTF-8 JSON bytes.

use std::io;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    /// The declared length exceeds [`MAX_FRAME_BYTES`]; the body was not read.
    TooLarge(u64),
    InvalidJson(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::TooLarge(length) => write!(
                f,
                "frame of {length} bytes exceeds the {MAX_FRAME_BYTES}-byte limit"
            ),
            Self::InvalidJson(error) => write!(f, "frame is not valid JSON: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Reads one frame; `Ok(None)` is a clean end of stream before a frame starts.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Value>, FrameError> {
    let mut header = [0_u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        let read = reader.read(&mut header[filled..]).await?;
        if read == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into()));
        }
        filled += read;
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(length as u64));
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body).await?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| FrameError::InvalidJson(error.to_string()))
}

/// Serializes and writes one frame; oversized values are rejected before writing.
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &impl Serialize,
) -> Result<(), FrameError> {
    let body =
        serde_json::to_vec(value).map_err(|error| FrameError::InvalidJson(error.to_string()))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(body.len() as u64));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::{AsyncWriteExt, duplex};

    use super::*;

    #[tokio::test]
    async fn round_trips_and_reports_clean_eof() {
        let (mut a, mut b) = duplex(1024);
        write_frame(&mut a, &json!({"id": 1, "method": "x"}))
            .await
            .unwrap();
        drop(a);
        assert_eq!(
            read_frame(&mut b).await.unwrap(),
            Some(json!({"id": 1, "method": "x"}))
        );
        assert!(read_frame(&mut b).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_oversized_declarations_without_reading_the_body() {
        let (mut a, mut b) = duplex(64);
        a.write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
            .await
            .unwrap();
        assert!(matches!(
            read_frame(&mut b).await,
            Err(FrameError::TooLarge(length)) if length == MAX_FRAME_BYTES as u64 + 1
        ));
    }

    #[tokio::test]
    async fn accepts_the_exact_limit() {
        let (mut a, mut b) = duplex(MAX_FRAME_BYTES + 8);
        // A JSON string of exactly MAX_FRAME_BYTES bytes, including its quotes.
        let value = Value::String("x".repeat(MAX_FRAME_BYTES - 2));
        let writer = tokio::spawn(async move { write_frame(&mut a, &value).await.map(|_| a) });
        let read = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(read.as_str().unwrap().len(), MAX_FRAME_BYTES - 2);
        writer.await.unwrap().unwrap();
        let too_big = Value::String("x".repeat(MAX_FRAME_BYTES - 1));
        let (mut c, _d) = duplex(16);
        assert!(matches!(
            write_frame(&mut c, &too_big).await,
            Err(FrameError::TooLarge(_))
        ));
    }

    #[tokio::test]
    async fn reports_truncated_and_invalid_frames() {
        let (mut a, mut b) = duplex(64);
        a.write_all(&[0, 0]).await.unwrap();
        drop(a);
        assert!(matches!(read_frame(&mut b).await, Err(FrameError::Io(_))));

        let (mut a, mut b) = duplex(64);
        a.write_all(&3_u32.to_be_bytes()).await.unwrap();
        a.write_all(b"{x}").await.unwrap();
        assert!(matches!(
            read_frame(&mut b).await,
            Err(FrameError::InvalidJson(_))
        ));
    }
}
