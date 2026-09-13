use std::io;

use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

mod wire {
    include!(concat!(env!("OUT_DIR"), "/pilo.protocol.rs"));
}

pub const PROTOCOL_VERSION: u32 = 3;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_BINARY_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
pub const SERVER_CAPABILITIES: &[&str] = &[
    "server.ping",
    "server.status",
    "environment.inspect",
    "command.run",
    "fs.read_dir",
    "fs.read_file",
    "fs.write_file",
    "fs.stat",
    "fs.mkdir",
    "fs.mkdir_absolute",
    "fs.rename",
    "fs.remove",
    "fs.search",
    "session.scan",
    "session.read",
    "session.discover",
    "session.watch_start",
    "session.watch_stop",
    "preview.ports",
    "terminal.open",
    "terminal.write",
    "terminal.resize",
    "terminal.close",
    "pi.start",
    "pi.send",
    "pi.stop",
];

#[derive(Clone, Debug, PartialEq)]
pub enum Envelope {
    Request {
        id: u64,
        method: String,
        params: Value,
        binary: Vec<Vec<u8>>,
    },
    Response {
        id: u64,
        result: Option<Value>,
        binary: Vec<Vec<u8>>,
        error: Option<RpcError>,
    },
    Event {
        stream_id: String,
        event: String,
        data: Value,
        binary: Vec<Vec<u8>>,
    },
}

impl Envelope {
    pub fn request(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self::Request {
            id,
            method: method.into(),
            params,
            binary: Vec::new(),
        }
    }

    pub fn request_with_binary(
        id: u64,
        method: impl Into<String>,
        params: Value,
        binary: Vec<Vec<u8>>,
    ) -> Self {
        Self::Request {
            id,
            method: method.into(),
            params,
            binary,
        }
    }

    pub fn response(id: u64, result: Value) -> Self {
        Self::Response {
            id,
            result: Some(result),
            binary: Vec::new(),
            error: None,
        }
    }

    pub fn response_with_binary(id: u64, result: Value, binary: Vec<Vec<u8>>) -> Self {
        Self::Response {
            id,
            result: Some(result),
            binary,
            error: None,
        }
    }

    pub fn error(id: u64, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Response {
            id,
            result: None,
            binary: Vec::new(),
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
            binary: Vec::new(),
        }
    }

    pub fn event_with_binary(
        stream_id: impl Into<String>,
        event: impl Into<String>,
        data: Value,
        binary: Vec<Vec<u8>>,
    ) -> Self {
        Self::Event {
            stream_id: stream_id.into(),
            event: event.into(),
            data,
            binary,
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
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub protocol_version: u32,
    pub server_version: String,
    pub pid: u32,
    pub uptime_ms: u64,
    pub active_requests: usize,
    pub max_in_flight_requests: usize,
    pub pi_processes: usize,
    pub terminals: usize,
    pub session_watchers: usize,
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
    #[serde(default)]
    pub unchanged: bool,
    #[serde(default)]
    pub deferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_user_message_preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn encode_json(value: &Value) -> io::Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn decode_json(bytes: &[u8]) -> io::Result<Value> {
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn to_wire(envelope: &Envelope) -> io::Result<wire::Envelope> {
    use wire::envelope::Payload;
    let payload = match envelope {
        Envelope::Request {
            id,
            method,
            params,
            binary,
        } => Payload::Request(wire::Request {
            id: *id,
            method: method.clone(),
            json: encode_json(params)?,
            binary: binary.clone(),
        }),
        Envelope::Response {
            id,
            result,
            binary,
            error,
        } => Payload::Response(wire::Response {
            id: *id,
            json: result
                .as_ref()
                .map(encode_json)
                .transpose()?
                .unwrap_or_default(),
            binary: binary.clone(),
            error: error.as_ref().map(|error| wire::RpcError {
                code: error.code.clone(),
                message: error.message.clone(),
            }),
        }),
        Envelope::Event {
            stream_id,
            event,
            data,
            binary,
        } => Payload::Event(wire::Event {
            stream_id: stream_id.clone(),
            event: event.clone(),
            json: encode_json(data)?,
            binary: binary.clone(),
        }),
    };
    Ok(wire::Envelope {
        payload: Some(payload),
    })
}

fn from_wire(envelope: wire::Envelope) -> io::Result<Envelope> {
    use wire::envelope::Payload;
    match envelope.payload.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "pilo protobuf envelope has no payload",
        )
    })? {
        Payload::Request(request) => Ok(Envelope::Request {
            id: request.id,
            method: request.method,
            params: decode_json(&request.json)?,
            binary: request.binary,
        }),
        Payload::Response(response) => Ok(Envelope::Response {
            id: response.id,
            result: if response.json.is_empty() {
                None
            } else {
                Some(decode_json(&response.json)?)
            },
            binary: response.binary,
            error: response.error.map(|error| RpcError {
                code: error.code,
                message: error.message,
            }),
        }),
        Payload::Event(event) => Ok(Envelope::Event {
            stream_id: event.stream_id,
            event: event.event,
            data: decode_json(&event.json)?,
            binary: event.binary,
        }),
    }
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
    let wire = wire::Envelope::decode(payload.as_slice())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    from_wire(wire).map(Some)
}

pub async fn write_frame<W>(writer: &mut W, envelope: &Envelope) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let wire = to_wire(envelope)?;
    let length = wire.encoded_len();
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid pilo protocol payload length {length}"),
        ));
    }
    writer.write_all(&(length as u32).to_le_bytes()).await?;
    let mut payload = Vec::with_capacity(length);
    wire.encode(&mut payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip_preserves_envelope_and_binary() {
        let expected = Envelope::request_with_binary(
            7,
            "fs.write_file",
            serde_json::json!({ "path": "asset.bin" }),
            vec![vec![0, 1, 2, 254, 255]],
        );
        let (mut client, mut server) = tokio::io::duplex(4096);
        let write = tokio::spawn(async move { write_frame(&mut client, &expected).await.unwrap() });
        let decoded = read_frame(&mut server).await.unwrap().unwrap();
        write.await.unwrap();
        assert_eq!(
            decoded,
            Envelope::request_with_binary(
                7,
                "fs.write_file",
                serde_json::json!({ "path": "asset.bin" }),
                vec![vec![0, 1, 2, 254, 255]],
            )
        );
    }

    #[test]
    fn wire_binary_is_not_json_or_base64() {
        let bytes = vec![0, 1, 2, 254, 255];
        let wire = to_wire(&Envelope::event_with_binary(
            "terminal:1",
            "terminal.output",
            Value::Null,
            vec![bytes.clone()],
        ))
        .unwrap();
        let mut encoded = Vec::new();
        wire.encode(&mut encoded).unwrap();
        assert!(encoded.windows(bytes.len()).any(|window| window == bytes));
        assert!(!encoded.windows(8).any(|window| window == b"AAEC/v8="));
    }
}
