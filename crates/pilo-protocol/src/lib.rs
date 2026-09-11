use std::io;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Envelope {
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Response {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Event {
        stream_id: String,
        event: String,
        #[serde(default)]
        data: Value,
    },
}

impl Envelope {
    pub fn response(id: u64, result: Value) -> Self {
        Self::Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: u64, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Response {
            id,
            result: None,
            error: Some(RpcError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }

    pub fn event(stream_id: impl Into<String>, event: impl Into<String>, data: Value) -> Self {
        Self::Event {
            stream_id: stream_id.into(),
            event: event.into(),
            data,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHello {
    pub protocol_version: u32,
    pub server_version: String,
    pub os: String,
    pub arch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub cwd: String,
    pub path: String,
    pub home: String,
    pub shell: String,
    pub pi_executable: String,
    pub pi_version: String,
    pub node_executable: String,
    pub node_version: String,
    pub git_executable: String,
    pub git_version: String,
    pub git_branch: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub path: String,
    pub name: String,
    pub kind: FsEntryKind,
    pub size: u64,
    pub modified_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub path: String,
    pub size: u64,
    pub mtime_ns: u64,
    pub header: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub async fn read_frame<R>(reader: &mut R) -> io::Result<Option<Envelope>>
where
    R: AsyncRead + Unpin,
{
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid pilo protocol frame length {length}"),
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub async fn write_frame<W>(writer: &mut W, envelope: &Envelope) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let payload = serde_json::to_vec(envelope)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid pilo protocol payload length {}", payload.len()),
        ));
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip_preserves_envelope() {
        let expected = Envelope::Request {
            id: 7,
            method: "fs.read_file".to_owned(),
            params: serde_json::json!({ "path": "src/App.tsx" }),
        };
        let (mut client, mut server) = tokio::io::duplex(4096);
        let write = tokio::spawn(async move { write_frame(&mut client, &expected).await.unwrap() });
        let decoded = read_frame(&mut server).await.unwrap().unwrap();
        write.await.unwrap();
        assert_eq!(
            decoded,
            Envelope::Request {
                id: 7,
                method: "fs.read_file".to_owned(),
                params: serde_json::json!({ "path": "src/App.tsx" }),
            }
        );
    }
}
