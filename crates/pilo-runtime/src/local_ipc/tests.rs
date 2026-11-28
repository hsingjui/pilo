use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use pilo_ipc::{Endpoint, MAX_FRAME_BYTES, UnixEndpoint, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, net::UnixStream};

use super::*;
use crate::host_paths::HostPaths;

struct Scratch(PathBuf);

impl Scratch {
    // macOS limits socket paths to ~104 bytes, so avoid the long per-user temp dir.
    fn new() -> Self {
        let mut bytes = [0_u8; 6];
        getrandom::fill(&mut bytes).unwrap();
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = PathBuf::from(format!("/tmp/pilo-ipc-test-{name}"));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn endpoint(&self) -> UnixEndpoint {
        UnixEndpoint {
            path: self.0.join("run/app.test.sock"),
            private_dir: Some(self.0.join("run")),
        }
    }

    fn runtime(&self) -> Runtime {
        Runtime::new(HostPaths::new(self.0.join("data"), self.0.join("resources")).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config() -> LocalIpcConfig {
    LocalIpcConfig {
        app_id: "app.test".to_owned(),
        app_version: "9.9.9".to_owned(),
        installation: None,
    }
}

async fn start(runtime: &Runtime, endpoint: &UnixEndpoint) -> Result<LocalIpcServer, String> {
    runtime
        .start_local_ipc_at(Endpoint::Unix(endpoint.clone()), config())
        .await
}

async fn hello(path: &Path, protocol: &str) -> (UnixStream, Value) {
    let mut stream = UnixStream::connect(path).await.unwrap();
    write_frame(
        &mut stream,
        &json!({"protocol": protocol, "client": "pilo-cli", "version": "0.0.0"}),
    )
    .await
    .unwrap();
    let reply = read_frame(&mut stream).await.unwrap().unwrap();
    (stream, reply)
}

async fn call(stream: &mut UnixStream, id: u64, method: &str, params: Value) -> Value {
    write_frame(
        stream,
        &json!({"id": id, "method": method, "params": params}),
    )
    .await
    .unwrap();
    read_frame(stream).await.unwrap().unwrap()
}

#[tokio::test]
async fn hello_then_local_calls_dispatch_with_full_scope() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    let server = start(&runtime, &endpoint).await.unwrap();

    let (mut stream, reply) = hello(&endpoint.path, "2.3").await;
    assert!(reply.get("result").is_none(), "{reply}");
    let hello = &reply;
    assert_eq!(hello["protocol"], "2.0");
    assert_eq!(hello["appVersion"], "9.9.9");
    assert!(hello["hostId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(hello["capabilities"]["methods"].is_array());

    // project.list is Chat and project.add is Workspace; Local reaches both.
    let listed = call(&mut stream, 1, "project.list", json!({})).await;
    assert_eq!(listed["id"], 1);
    assert!(listed["result"].is_array(), "{listed}");
    let status = call(
        &mut stream,
        90,
        "session.status",
        json!({"projectId": "missing", "sessionId": "s"}),
    )
    .await;
    assert_eq!(status["error"]["code"], "not_found", "{status}");
    let rejected = call(
        &mut stream,
        2,
        "project.add",
        json!({"connectionId": "missing", "path": "/nowhere"}),
    )
    .await;
    assert_eq!(rejected["id"], 2);
    assert_ne!(rejected["error"]["code"], "forbidden", "{rejected}");

    let unknown = call(&mut stream, 3, "nope.nothing", json!({})).await;
    assert_eq!(unknown["error"]["code"], "not_found");
    let shell_only = call(&mut stream, 4, "host.shutdown", json!({})).await;
    assert_eq!(shell_only["error"]["code"], "unsupported_method");
    let binary = host_api::methods()
        .iter()
        .find(|spec| spec.kind != MethodKind::Json)
        .map(|spec| spec.name);
    if let Some(binary) = binary {
        let unsupported = call(&mut stream, 5, binary, json!({})).await;
        assert_eq!(unsupported["error"]["code"], "unsupported_method");
    }
    let missing_id = {
        write_frame(&mut stream, &json!({"method": "project.list"}))
            .await
            .unwrap();
        read_frame(&mut stream).await.unwrap().unwrap()
    };
    assert_eq!(missing_id["error"]["code"], "invalid_params");

    server.stop().await;
    assert!(!endpoint.path.exists());
}

#[tokio::test]
async fn stopping_ipc_closes_connected_idle_clients() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    let server = start(&runtime, &endpoint).await.unwrap();
    let (mut stream, reply) = hello(&endpoint.path, PROTOCOL_VERSION).await;
    assert_eq!(reply["protocol"], PROTOCOL_VERSION);

    server.stop().await;
    assert!(!endpoint.path.exists());
    let eof = tokio::time::timeout(Duration::from_secs(1), read_frame(&mut stream))
        .await
        .expect("stopping local IPC must close a connected idle client");
    assert!(eof.unwrap().is_none());
}

#[tokio::test]
async fn rejects_incompatible_major_versions_and_malformed_hello() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    let _server = start(&runtime, &endpoint).await.unwrap();

    let (mut stream, reply) = hello(&endpoint.path, "3.0").await;
    assert_eq!(reply["error"]["code"], "incompatible_protocol");
    assert!(read_frame(&mut stream).await.unwrap().is_none());

    let mut stream = UnixStream::connect(&endpoint.path).await.unwrap();
    write_frame(&mut stream, &json!({"protocol": "2.0"}))
        .await
        .unwrap();
    let reply = read_frame(&mut stream).await.unwrap().unwrap();
    assert_eq!(reply["error"]["code"], "invalid_params");
}

#[tokio::test]
async fn rejects_oversized_and_invalid_frames_then_closes() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    let _server = start(&runtime, &endpoint).await.unwrap();

    let (mut stream, _) = hello(&endpoint.path, "2.0").await;
    stream
        .write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
        .await
        .unwrap();
    let reply = read_frame(&mut stream).await.unwrap().unwrap();
    assert_eq!(reply["error"]["code"], "invalid_frame");
    assert!(read_frame(&mut stream).await.unwrap().is_none());

    let mut stream = UnixStream::connect(&endpoint.path).await.unwrap();
    stream.write_all(&2_u32.to_be_bytes()).await.unwrap();
    stream.write_all(b"{]").await.unwrap();
    let reply = read_frame(&mut stream).await.unwrap().unwrap();
    assert_eq!(reply["error"]["code"], "invalid_frame");
}

#[tokio::test]
async fn closes_silent_clients_after_the_hello_timeout_and_survives_disconnects() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    let _server = start(&runtime, &endpoint).await.unwrap();

    // A client that drops mid-session does not take the endpoint down.
    let (stream, _) = hello(&endpoint.path, "2.0").await;
    drop(stream);

    let mut silent = UnixStream::connect(&endpoint.path).await.unwrap();
    let started = std::time::Instant::now();
    let closed = tokio::time::timeout(Duration::from_secs(8), read_frame(&mut silent))
        .await
        .expect("Host must close a client that never sends hello");
    assert!(closed.unwrap().is_none());
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(4500), "{waited:?}");

    let (_stream, reply) = hello(&endpoint.path, "2.0").await;
    assert!(reply["hostId"].is_string(), "{reply}");
}

#[tokio::test]
async fn reclaims_only_its_own_stale_socket() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    std::fs::create_dir_all(endpoint.private_dir.as_ref().unwrap()).unwrap();

    // A live endpoint (another running Host) is neither replaced nor removed.
    let live = std::os::unix::net::UnixListener::bind(&endpoint.path).unwrap();
    let error = start(&runtime, &endpoint).await.err().unwrap();
    assert!(error.contains("already listening"), "{error}");
    assert!(endpoint.path.exists());

    // Once nobody listens the socket is stale and may be rebound.
    drop(live);
    assert!(endpoint.path.exists());
    let server = start(&runtime, &endpoint).await.unwrap();
    let mode = std::fs::metadata(&endpoint.path)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    server.stop().await;

    // Anything that is not a socket is left alone.
    std::fs::write(&endpoint.path, b"keep").unwrap();
    let error = start(&runtime, &endpoint).await.err().unwrap();
    assert!(error.contains("not this user's Pilo socket"), "{error}");
    assert_eq!(std::fs::read(&endpoint.path).unwrap(), b"keep");
}

#[tokio::test]
async fn private_directory_is_0700_and_never_a_symlink() {
    let scratch = Scratch::new();
    let runtime = scratch.runtime();
    let endpoint = scratch.endpoint();
    let dir = endpoint.private_dir.clone().unwrap();

    let server = start(&runtime, &endpoint).await.unwrap();
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    server.stop().await;

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let server = start(&runtime, &endpoint).await.unwrap();
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    server.stop().await;

    std::fs::remove_dir_all(&dir).unwrap();
    let target = scratch.0.join("elsewhere");
    std::fs::create_dir_all(&target).unwrap();
    std::os::unix::fs::symlink(&target, &dir).unwrap();
    let error = start(&runtime, &endpoint).await.err().unwrap();
    assert!(error.contains("not a directory"), "{error}");
    assert!(std::fs::read_dir(&target).unwrap().next().is_none());
}
