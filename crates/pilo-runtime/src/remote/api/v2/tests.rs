use std::{path::PathBuf, sync::Arc};

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};

use super::*;
use crate::{
    Runtime,
    events::{EventBatch, EventQueueLimits, PiProcessState, RuntimeEvent, RuntimeEventEnvelope},
    host_paths::HostPaths,
    initialize_local_server_binary,
};

struct TestHost {
    root: PathBuf,
    runtime: Runtime,
    port: u16,
}

fn pick_free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

impl TestHost {
    async fn start_ephemeral(label: &str) -> Self {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "pilo-v2-e2e-{label}-{}-{}-{n}",
            std::process::id(),
            storage::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
        let port = pick_free_port();
        runtime.remote.set_port(&runtime, port).await.unwrap();
        let state = runtime.remote.set_enabled(&runtime, true).await.unwrap();
        assert!(state.running);
        assert_eq!(state.port, port);
        Self {
            root,
            runtime,
            port,
        }
    }

    /// Local projects need the workspace's `pilo-server` build and a Pi
    /// executable; a stub answering `--version` stands in for Pi.
    async fn start_with_local_projects(label: &str) -> Self {
        let Some(server_bin) = locate_pilo_server_binary() else {
            panic!("pilo-server binary not found; run `cargo build -p pilo-server` first");
        };
        initialize_local_server_binary(server_bin);
        let host = Self::start_ephemeral(label).await;
        let pi = host.root.join("pi");
        std::fs::write(&pi, "#!/bin/sh\necho 0.0.0-test\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&pi, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let local = crate::connections::local_connection_get(&host.runtime).unwrap();
        crate::connections::connection_settings_update(
            &host.runtime,
            local.id,
            local.name,
            Some(pi.to_string_lossy().into_owned()),
        )
        .unwrap();
        host
    }

    async fn pair(&self, scopes: RemoteScopes, device_name: &str) -> (String, String) {
        let state = self
            .runtime
            .remote
            .regenerate_pairing(&self.runtime, scopes)
            .await
            .unwrap();
        let pairing_url = state.pairing_url.expect("pairing url");
        let secret = pairing_url
            .split("#pair=")
            .nth(1)
            .expect("pair secret")
            .to_owned();
        let (status, info) = http_json(
            self.port,
            "POST",
            "/api/v1/auth/pairing",
            None,
            None,
            &json!({ "secret": secret }),
        )
        .await;
        assert_eq!(status, 200, "pairing info failed: {info}");
        let address_id = info["addresses"][0]["id"]
            .as_str()
            .expect("address id")
            .to_owned();
        let mut digest = Sha256::new();
        digest.update(device_name.as_bytes());
        digest.update(storage::now_ms().to_le_bytes());
        let mut request_id = String::with_capacity(64);
        for byte in digest.finalize() {
            use std::fmt::Write;
            let _ = write!(&mut request_id, "{byte:02x}");
        }
        let (status, paired) = http_json(
            self.port,
            "POST",
            "/api/v1/auth/pair",
            None,
            None,
            &json!({
                "secret": secret,
                "addressId": address_id,
                "requestId": request_id,
                "deviceName": device_name,
            }),
        )
        .await;
        assert_eq!(status, 200, "pair failed: {paired}");
        (
            paired["token"].as_str().unwrap().to_owned(),
            paired["device"]["id"].as_str().unwrap().to_owned(),
        )
    }

    async fn cleanup(self) {
        self.runtime.shutdown().await;
        let _ = std::fs::remove_dir_all(self.root);
    }
}

async fn http_raw(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    origin: Option<&str>,
    content_type: Option<&str>,
    body: &[u8],
) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(origin) = origin {
        req.push_str(&format!("Origin: {origin}\r\n"));
    }
    if let Some(ct) = content_type {
        req.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    if let Err(error) = stream.write_all(body).await
        && !matches!(
            error.kind(),
            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
        )
    {
        panic!("unexpected write error: {error}");
    }

    let mut raw = Vec::new();
    if let Err(error) = stream.read_to_end(&mut raw).await
        && !(raw.windows(4).any(|w| w == b"\r\n\r\n")
            && error.kind() == std::io::ErrorKind::ConnectionReset)
    {
        panic!("unexpected read error: {error}");
    }
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("http header separator");
    let headers = String::from_utf8_lossy(&raw[..split]);
    let status = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse::<u16>()
        .unwrap();
    (status, raw[split + 4..].to_vec())
}

async fn http_json(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    origin: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    let encoded = serde_json::to_vec(body).unwrap();
    let (status, resp) = http_raw(
        port,
        method,
        path,
        token,
        origin,
        Some("application/json"),
        &encoded,
    )
    .await;
    let json = serde_json::from_slice(&resp)
        .unwrap_or_else(|_| json!({ "_raw": String::from_utf8_lossy(&resp).to_string() }));
    (status, json)
}

struct WsClient {
    reader: BufReader<TcpStream>,
}

impl WsClient {
    async fn connect(port: u16, path: &str, token: &str) -> Self {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut reader = BufReader::new(stream);
        let upgrade = format!(
            "GET {path} HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Protocol: pilo, pilo-token.{token}\r\n\r\n"
        );
        reader
            .get_mut()
            .write_all(upgrade.as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "HTTP/1.1 101 Switching Protocols");
        loop {
            line.clear();
            assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
            if line == "\r\n" {
                break;
            }
        }
        Self { reader }
    }

    async fn send_text(&mut self, value: &Value) {
        let payload = serde_json::to_vec(value).unwrap();
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = Vec::with_capacity(14 + payload.len());
        frame.push(0x81);
        if payload.len() <= 125 {
            frame.push(0x80 | (payload.len() as u8));
        } else if payload.len() <= 65535 {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        for (index, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[index % 4]);
        }
        self.reader.get_mut().write_all(&frame).await.unwrap();
    }

    async fn recv_frame(&mut self) -> Option<(u8, Vec<u8>)> {
        let mut header = [0u8; 2];
        if self.reader.read_exact(&mut header).await.is_err() {
            return None;
        }
        let opcode = header[0] & 0x0f;
        let len_byte = header[1] & 0x7f;
        let len = match len_byte {
            0..=125 => usize::from(len_byte),
            126 => {
                let mut ext = [0u8; 2];
                self.reader.read_exact(&mut ext).await.ok()?;
                usize::from(u16::from_be_bytes(ext))
            }
            127 => {
                let mut ext = [0u8; 8];
                self.reader.read_exact(&mut ext).await.ok()?;
                usize::try_from(u64::from_be_bytes(ext)).ok()?
            }
            _ => unreachable!(),
        };
        let mut payload = vec![0u8; len];
        self.reader.read_exact(&mut payload).await.ok()?;
        Some((opcode, payload))
    }

    async fn recv_json(&mut self) -> Value {
        let (opcode, payload) = tokio::time::timeout(Duration::from_secs(5), self.recv_frame())
            .await
            .expect("ws recv timeout")
            .expect("ws closed unexpectedly");
        assert_eq!(opcode, 0x1, "expected text frame, got opcode {opcode}");
        serde_json::from_slice(&payload).unwrap()
    }

    async fn expect_closed(&mut self) {
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some((opcode, _)) = self.recv_frame().await {
                if opcode == 0x8 {
                    return true;
                }
            }
            true
        })
        .await
        .expect("ws did not close in time");
        assert!(closed);
    }
}

fn locate_pilo_server_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let target_dir = exe.ancestors().find(|p| {
        p.file_name()
            .is_some_and(|n| n == "debug" || n == "release")
    })?;
    let candidate = target_dir.join(if cfg!(windows) {
        "pilo-server.exe"
    } else {
        "pilo-server"
    });
    candidate.is_file().then_some(candidate)
}

#[tokio::test]
async fn v2_dual_host_pairing_calls_scopes_origin_and_event_replay() {
    let host_a = TestHost::start_ephemeral("host-a").await;
    let host_b = TestHost::start_ephemeral("host-b").await;
    assert_ne!(host_a.port, host_b.port);

    let (token_a, _) = host_a.pair(RemoteScopes::Chat, "HostA-Client").await;
    let (token_b_chat, device_b_chat) = host_b.pair(RemoteScopes::Chat, "HostB-Chat").await;
    let (token_b_ws, _) = host_b
        .pair(RemoteScopes::ChatWorkspace, "HostB-Workspace")
        .await;

    // Distinct persisted hostIds across Host A and Host B.
    let mut ws_a = WsClient::connect(host_a.port, "/api/v2/events", &token_a).await;
    let hello_a = ws_a.recv_json().await;
    assert_eq!(hello_a["type"], "hello");
    assert_eq!(hello_a["protocolVersion"], PROTOCOL_VERSION);

    let mut ws_b = WsClient::connect(host_b.port, "/api/v2/events", &token_b_chat).await;
    let hello_b = ws_b.recv_json().await;
    assert_eq!(hello_b["type"], "hello");
    assert_eq!(hello_b["deviceId"], device_b_chat);
    assert_eq!(hello_b["scopes"], "chat");
    assert_eq!(hello_b["protocolVersion"], PROTOCOL_VERSION);
    assert_ne!(hello_a["hostId"], hello_b["hostId"]);
    assert!(hello_b["hostName"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(
        hello_b["capabilities"]["methods"]
            .as_array()
            .is_some_and(|m| !m.is_empty())
    );
    assert_eq!(hello_b["capabilities"]["methodsHash"], methods_hash());

    for (method, path) in [
        ("GET", "/api/v1/bootstrap"),
        ("GET", "/api/v1/sessions"),
        ("POST", "/api/v1/chat/rpc"),
        ("GET", "/api/v1/models"),
        ("GET", "/api/v1/files/image"),
        ("GET", "/api/v1/events"),
    ] {
        let response = http_raw(
            host_b.port,
            method,
            path,
            Some(&token_b_chat),
            None,
            None,
            &[],
        )
        .await;
        assert_eq!(response.0, 404, "{method} {path}");
    }
    let (status, device) = http_json(
        host_b.port,
        "GET",
        "/api/v1/auth/device",
        Some(&token_b_chat),
        None,
        &json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert!(device["expiresAtMs"].as_u64().is_some());
    let (status, renewed) = http_json(
        host_b.port,
        "POST",
        "/api/v1/auth/device/renew",
        Some(&token_b_chat),
        None,
        &json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert!(renewed["expiresAtMs"].as_u64().is_some());

    // Ping -> Pong.
    ws_b.send_text(&json!({ "type": "ping" })).await;
    assert_eq!(ws_b.recv_json().await["type"], "pong");

    // Chat scope can call bootstrap & read-only connections (no credentials).
    let (status, bootstrap) = http_json(
        host_b.port,
        "POST",
        "/api/v2/call/host.bootstrap",
        Some(&token_b_chat),
        None,
        &json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(bootstrap["ok"], true);

    let (status, connections) = http_json(
        host_b.port,
        "POST",
        "/api/v2/call/connection.list",
        Some(&token_b_chat),
        None,
        &json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(connections["ok"], true);
    assert!(
        connections["result"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    );

    // Scope enforcement: Chat denied workspace & admin; Workspace denied admin.
    let (status, err) = http_json(
        host_b.port,
        "POST",
        "/api/v2/call/project.add",
        Some(&token_b_chat),
        None,
        &json!({ "connectionId": "local", "path": host_b.root }),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(err["ok"], false);
    assert_eq!(err["error"]["code"], "forbidden");

    let (status, err) = http_json(
        host_b.port,
        "POST",
        "/api/v2/call/connection.ssh.password",
        Some(&token_b_ws),
        None,
        &json!({ "id": "ssh:test" }),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(err["ok"], false);
    assert_eq!(err["error"]["code"], "forbidden");

    let (status, err) = http_json(
        host_b.port,
        "POST",
        "/api/v2/call/host.shutdown",
        Some(&token_b_ws),
        None,
        &json!({}),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(err["error"]["code"], "forbidden");

    // CLI session methods are local-only: paired devices of any scope are refused.
    for token in [&token_b_chat, &token_b_ws] {
        for method in ["session.status", "session.create", "session.trash"] {
            let (status, err) = http_json(
                host_b.port,
                "POST",
                &format!("/api/v2/call/{method}"),
                Some(token),
                None,
                &json!({ "projectId": "p", "sessionId": "s" }),
            )
            .await;
            assert_eq!(status, 403, "{method}");
            assert_eq!(err["error"]["code"], "forbidden", "{method}");
        }
    }

    // Origin enforcement.
    let (status, _) = http_json(
        host_b.port,
        "POST",
        "/api/v2/call/host.bootstrap",
        Some(&token_b_chat),
        Some("https://evil.example"),
        &json!({}),
    )
    .await;
    assert_eq!(status, 403);

    // Event live delivery + disconnect + replay after=<seq>.
    host_b.runtime.events.send(RuntimeEventEnvelope::session(
        "s1".to_owned(),
        "p1".to_owned(),
        RuntimeEvent::ProcessState {
            generation: 1,
            state: PiProcessState::Running,
        },
    ));
    let live_batch = ws_b.recv_json().await;
    assert_eq!(live_batch["type"], "events");
    let seq1 = live_batch["events"][0]["sequence"].as_u64().unwrap();
    drop(ws_b);

    host_b.runtime.events.send(RuntimeEventEnvelope::session(
        "s1".to_owned(),
        "p1".to_owned(),
        RuntimeEvent::ProcessState {
            generation: 2,
            state: PiProcessState::Stopped,
        },
    ));
    let mut ws_b_reconnected = WsClient::connect(
        host_b.port,
        &format!("/api/v2/events?after={seq1}"),
        &token_b_chat,
    )
    .await;
    let hello2 = ws_b_reconnected.recv_json().await;
    assert_eq!(hello2["type"], "hello");
    assert_eq!(hello2["hostId"], hello_b["hostId"]);
    let replayed = ws_b_reconnected.recv_json().await;
    assert_eq!(replayed["type"], "events");
    assert_eq!(replayed["events"].as_array().unwrap().len(), 1);
    assert_eq!(replayed["events"][0]["generation"], 2);

    drop(ws_a);
    drop(ws_b_reconnected);
    host_a.cleanup().await;
    host_b.cleanup().await;
}

#[tokio::test]
async fn project_mutations_notify_native_and_web_clients() {
    let host = TestHost::start_with_local_projects("project-events").await;
    let (token, _) = host.pair(RemoteScopes::ChatWorkspace, "Workspace").await;
    let mut web = WsClient::connect(host.port, "/api/v2/events", &token).await;
    assert_eq!(web.recv_json().await["type"], "hello");
    let mut native = host.runtime.subscribe_events(EventQueueLimits {
        max_events: 32,
        max_bytes: 64 * 1024,
    });

    let dir = host.root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let add = json!({ "connectionId": "local", "path": dir });

    for local in [true, false] {
        let mut remove = Value::Null;
        for method in ["project.add", "project.remove"] {
            let params = if method == "project.add" {
                add.clone()
            } else {
                remove.clone()
            };
            let result = if local {
                host_api::call(&host.runtime, &host_api::Principal::Local, method, params)
                    .await
                    .unwrap()
            } else {
                let (status, body) = http_json(
                    host.port,
                    "POST",
                    &format!("/api/v2/call/{method}"),
                    Some(&token),
                    None,
                    &params,
                )
                .await;
                assert_eq!(status, 200, "{method} failed: {body}");
                body["result"].clone()
            };
            if method == "project.add" {
                remove = json!({ "projectId": result["id"].as_str().unwrap() });
            }

            let Some(EventBatch::Events(events)) = native.try_next_batch(32) else {
                panic!("{method} did not publish a native event (local={local})");
            };
            let sequence = events
                .iter()
                .find(|event| event.event.event == RuntimeEvent::ConfigurationChanged)
                .expect("native configuration_changed event")
                .sequence;
            let batch = web.recv_json().await;
            assert_eq!(batch["type"], "events");
            assert!(
                batch["events"].as_array().unwrap().iter().any(|event| {
                    event["type"] == "configuration_changed" && event["sequence"] == sequence
                }),
                "{method} did not publish the same event over WebSocket (local={local}): {batch}"
            );

            let projects = crate::project_api::project_list(&host.runtime).unwrap();
            let id = remove["projectId"].as_str().unwrap();
            assert_eq!(
                projects.iter().any(|project| project.id == id),
                method == "project.add",
            );
        }
    }

    drop(web);
    host.cleanup().await;
}

#[tokio::test]
async fn v2_terminal_ownership_disconnect_retention_snapshot_toggle_and_revoke() {
    let host = TestHost::start_with_local_projects("term").await;
    host.runtime
        .terminals
        .set_disconnect_retention(Duration::from_secs(5));

    let (token_dev1, dev1_id) = host.pair(RemoteScopes::ChatWorkspace, "Dev1").await;
    let (token_dev2, _) = host.pair(RemoteScopes::ChatWorkspace, "Dev2").await;

    let project_dir = host.root.join("proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    let (status, added) = http_json(
        host.port,
        "POST",
        "/api/v2/call/project.add",
        Some(&token_dev1),
        None,
        &json!({ "connectionId": "local", "path": project_dir }),
    )
    .await;
    assert_eq!(status, 200, "project.add failed: {added}");
    let project_id = added["result"]["id"].as_str().unwrap().to_owned();

    // Open terminal as Dev1 and subscribe on v2 WS.
    let mut ws1 = WsClient::connect(host.port, "/api/v2/events", &token_dev1).await;
    let _hello = ws1.recv_json().await;

    let (status, opened) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.open",
        Some(&token_dev1),
        None,
        &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(status, 200, "terminal.open failed: {opened}");
    let terminal_id = opened["result"]["id"].as_str().unwrap().to_owned();

    ws1.send_text(&json!({ "type": "terminal.subscribe", "terminalId": terminal_id }))
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Dev2 cannot access Dev1's terminal.
    let (status, err) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.snapshot",
        Some(&token_dev2),
        None,
        &json!({ "terminalId": terminal_id }),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(err["error"]["code"], "forbidden");

    // Write via /api/v2/upload/terminal.write and receive output over WS.
    let (status, _) = http_raw(
        host.port,
        "POST",
        &format!("/api/v2/upload/terminal.write?terminalId={terminal_id}"),
        Some(&token_dev1),
        None,
        Some("application/octet-stream"),
        b"echo PILO_V2_LIVE_MARKER\n",
    )
    .await;
    assert_eq!(status, 200);

    let mut received = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !received.contains("PILO_V2_LIVE_MARKER") {
            let msg = ws1.recv_json().await;
            if msg["type"] == "terminal"
                && msg["event"] == "output"
                && msg["terminalId"] == terminal_id
                && let Some(data) = msg["data"].as_str()
                && let Ok(bytes) = BASE64.decode(data)
            {
                received.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    })
    .await
    .expect("did not receive live terminal output over v2 WS");

    // Disconnect WS -> PTY stays alive during retention window -> write while disconnected ->
    // reconnect -> terminal.attach + terminal.snapshot recovers buffered output.
    drop(ws1);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (status, _) = http_raw(
        host.port,
        "POST",
        &format!("/api/v2/upload/terminal.write?terminalId={terminal_id}"),
        Some(&token_dev1),
        None,
        Some("application/octet-stream"),
        b"echo PILO_V2_RECONNECT_MARKER\n",
    )
    .await;
    assert_eq!(status, 200);

    let mut ws1_reconnected = WsClient::connect(host.port, "/api/v2/events", &token_dev1).await;
    let _hello = ws1_reconnected.recv_json().await;
    ws1_reconnected
        .send_text(&json!({ "type": "terminal.subscribe", "terminalId": terminal_id, "ack": true }))
        .await;
    let ack = ws1_reconnected.recv_json().await;
    assert_eq!(ack["type"], "terminal.subscribed");
    assert_eq!(ack["terminalId"], terminal_id);
    let subscribed_offset = ack["offset"].as_u64().unwrap();
    let (status, attached) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.attach",
        Some(&token_dev1),
        None,
        &json!({ "terminalId": terminal_id }),
    )
    .await;
    assert_eq!(status, 200, "terminal.attach failed: {attached}");

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (status, snap) = http_json(
                host.port,
                "POST",
                "/api/v2/call/terminal.snapshot",
                Some(&token_dev1),
                None,
                &json!({ "terminalId": terminal_id }),
            )
            .await;
            assert_eq!(status, 200);
            assert!(snap["result"]["endOffset"].as_u64().unwrap() >= subscribed_offset);
            let bytes = BASE64
                .decode(snap["result"]["data"].as_str().unwrap())
                .unwrap();
            let text = String::from_utf8_lossy(&bytes);
            if text.contains("PILO_V2_RECONNECT_MARKER") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("terminal.snapshot did not include reconnect marker");

    // Disabling remote access closes WS and closes remote-owned terminals.
    let disabled = host
        .runtime
        .remote
        .set_enabled(&host.runtime, false)
        .await
        .unwrap();
    assert!(!disabled.running);
    ws1_reconnected.expect_closed().await;
    assert!(
        !host
            .runtime
            .terminals
            .owns(&TerminalOwner::Device(dev1_id.clone()), &terminal_id)
    );

    // Re-enable remote access, open another terminal, verify revoke closes WS & terminal.
    let reenabled = host
        .runtime
        .remote
        .set_enabled(&host.runtime, true)
        .await
        .unwrap();
    assert!(reenabled.running);
    let mut ws_rev = WsClient::connect(reenabled.port, "/api/v2/events", &token_dev1).await;
    let _hello = ws_rev.recv_json().await;
    let (status, opened2) = http_json(
        reenabled.port,
        "POST",
        "/api/v2/call/terminal.open",
        Some(&token_dev1),
        None,
        &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(status, 200);
    let term2 = opened2["result"]["id"].as_str().unwrap().to_owned();
    assert!(
        host.runtime
            .terminals
            .owns(&TerminalOwner::Device(dev1_id.clone()), &term2)
    );

    host.runtime
        .remote
        .revoke_device(&host.runtime, &dev1_id)
        .await
        .unwrap();
    ws_rev.expect_closed().await;
    assert!(
        !host
            .runtime
            .terminals
            .owns(&TerminalOwner::Device(dev1_id), &term2)
    );

    // Short retention expiry test with Dev2.
    host.runtime
        .terminals
        .set_disconnect_retention(Duration::from_millis(120));
    let ws2 = WsClient::connect(reenabled.port, "/api/v2/events", &token_dev2).await;
    let (status, opened3) = http_json(
        reenabled.port,
        "POST",
        "/api/v2/call/terminal.open",
        Some(&token_dev2),
        None,
        &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(status, 200);
    let term3 = opened3["result"]["id"].as_str().unwrap().to_owned();
    drop(ws2);
    tokio::time::sleep(Duration::from_millis(350)).await;
    let (status, err) = http_json(
        reenabled.port,
        "POST",
        "/api/v2/call/terminal.attach",
        Some(&token_dev2),
        None,
        &json!({ "terminalId": term3 }),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(err["error"]["code"], "not_found");

    host.cleanup().await;
}

#[tokio::test]
async fn v2_terminal_open_rejects_downgraded_revoked_disabled_and_expires_headless_terminal() {
    let host = TestHost::start_with_local_projects("term-race").await;
    let project_dir = host.root.join("term-race-proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project_path = project_dir.to_string_lossy().to_string();

    let (token_dev1, dev1_id) = host.pair(RemoteScopes::ChatWorkspace, "Dev1").await;
    let (_token_dev2, dev2_id) = host.pair(RemoteScopes::ChatWorkspace, "Dev2").await;

    let (status, added) = http_json(
        host.port,
        "POST",
        "/api/v2/call/project.add",
        Some(&token_dev1),
        None,
        &json!({ "connectionId": "local", "path": project_path }),
    )
    .await;
    assert_eq!(status, 200);
    let project_id = added["result"]["id"].as_str().unwrap().to_owned();

    // 1. Opening a terminal via HTTP with no active v2 WS starts the retention timer;
    //    calling HTTP terminal.attach without a subscribed WS must NOT cancel the timer.
    host.runtime
        .terminals
        .set_disconnect_retention(Duration::from_millis(180));
    let (status, opened_headless) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.open",
        Some(&token_dev1),
        None,
        &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(status, 200);
    let headless_id = opened_headless["result"]["id"].as_str().unwrap().to_owned();
    let (status, attached_no_ws) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.attach",
        Some(&token_dev1),
        None,
        &json!({ "terminalId": headless_id }),
    )
    .await;
    assert_eq!(status, 200, "initial attach failed: {attached_no_ws}");
    tokio::time::sleep(Duration::from_millis(350)).await;
    let (status, err) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.attach",
        Some(&token_dev1),
        None,
        &json!({ "terminalId": headless_id }),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(err["error"]["code"], "not_found");

    // 2. Opening without WS and subscribing via WS before retention cancels the timer.
    host.runtime
        .terminals
        .set_disconnect_retention(Duration::from_millis(200));
    let (status, opened_sub) = http_json(
        host.port,
        "POST",
        "/api/v2/call/terminal.open",
        Some(&token_dev1),
        None,
        &json!({ "projectId": project_id, "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(status, 200);
    let sub_id = opened_sub["result"]["id"].as_str().unwrap().to_owned();
    let mut ws1 = WsClient::connect(host.port, "/api/v2/events", &token_dev1).await;
    let _hello = ws1.recv_json().await;
    ws1.send_text(&json!({ "type": "terminal.subscribe", "terminalId": sub_id }))
        .await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(
        host.runtime
            .terminals
            .owns(&TerminalOwner::Device(dev1_id.clone()), &sub_id),
        "subscribing via WS must cancel the headless retention timer"
    );
    drop(ws1);

    // 3. Re-validation at commit_if rejects downgraded, revoked, and disabled remote access.
    //    Also test concurrent open + scope downgrade / revoke leaves no orphaned PTY.
    let (open_res, downgrade_res) = tokio::join!(
        crate::project_api::project_terminal_open_for_owner(
            &host.runtime,
            project_id.clone(),
            80,
            24,
            TerminalOwner::Device(dev1_id.clone()),
        ),
        host.runtime
            .remote
            .set_device_scopes(&host.runtime, &dev1_id, RemoteScopes::Chat),
    );
    downgrade_res.unwrap();
    if let Ok(info) = open_res {
        // If open committed before downgrade, downgrade must have closed it immediately.
        assert!(
            !host
                .runtime
                .terminals
                .owns(&TerminalOwner::Device(dev1_id.clone()), &info.id),
            "concurrent downgrade must not leave a terminal owned by a downgraded device"
        );
    }
    // Subsequent open for downgraded device fails with Forbidden.
    let downgraded_err = crate::project_api::project_terminal_open_for_owner(
        &host.runtime,
        project_id.clone(),
        80,
        24,
        TerminalOwner::Device(dev1_id.clone()),
    )
    .await
    .expect_err("downgraded device must be rejected");
    assert_eq!(downgraded_err.code, ErrorCode::Forbidden);

    // Concurrent open + revoke for Dev2.
    let (open_res2, revoke_res) = tokio::join!(
        crate::project_api::project_terminal_open_for_owner(
            &host.runtime,
            project_id.clone(),
            80,
            24,
            TerminalOwner::Device(dev2_id.clone()),
        ),
        host.runtime.remote.revoke_device(&host.runtime, &dev2_id),
    );
    revoke_res.unwrap();
    if let Ok(info) = open_res2 {
        assert!(
            !host
                .runtime
                .terminals
                .owns(&TerminalOwner::Device(dev2_id.clone()), &info.id),
            "concurrent revoke must not leave a terminal owned by a revoked device"
        );
    }
    let revoked_err = crate::project_api::project_terminal_open_for_owner(
        &host.runtime,
        project_id.clone(),
        80,
        24,
        TerminalOwner::Device(dev2_id.clone()),
    )
    .await
    .expect_err("revoked device must be rejected");
    assert_eq!(revoked_err.code, ErrorCode::Forbidden);

    // Disabling remote access rejects open with Unavailable.
    let (_token_dev3, dev3_id) = host.pair(RemoteScopes::ChatWorkspace, "Dev3").await;
    host.runtime
        .remote
        .set_enabled(&host.runtime, false)
        .await
        .unwrap();
    let disabled_err = crate::project_api::project_terminal_open_for_owner(
        &host.runtime,
        project_id,
        80,
        24,
        TerminalOwner::Device(dev3_id),
    )
    .await
    .expect_err("disabled remote access must reject remote terminal open");
    assert_eq!(disabled_err.code, ErrorCode::Unavailable);

    host.cleanup().await;
}

#[tokio::test]
async fn v2_terminal_open_barrier_concurrency_ws_drop_downgrade_and_cancellation() {
    let host = TestHost::start_with_local_projects("term-barrier").await;
    let project_dir = host.root.join("barrier-proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project_path = project_dir.to_string_lossy().to_string();

    let (token_dev1, dev1_id) = host.pair(RemoteScopes::ChatWorkspace, "BarrierDev1").await;
    let (status, added) = http_json(
        host.port,
        "POST",
        "/api/v2/call/project.add",
        Some(&token_dev1),
        None,
        &json!({ "connectionId": "local", "path": project_path }),
    )
    .await;
    assert_eq!(status, 200);
    let project_id = added["result"]["id"].as_str().unwrap().to_owned();

    // 1. Barrier between PTY start and commit_if while WS disconnects -> commit_if must see
    //    0 WS connections under the unified lock and arm the retention timer so PTY expires.
    host.runtime
        .terminals
        .set_disconnect_retention(Duration::from_millis(120));
    let mut ws1 = WsClient::connect(host.port, "/api/v2/events", &token_dev1).await;
    let _hello = ws1.recv_json().await;

    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    host.runtime
        .terminals
        .set_open_barrier(Some(Arc::clone(&barrier)));

    let runtime_clone = host.runtime.clone();
    let project_clone = project_id.clone();
    let owner1 = TerminalOwner::Device(dev1_id.clone());
    let open_handle = tokio::spawn(async move {
        crate::project_api::project_terminal_open_for_owner(
            &runtime_clone,
            project_clone,
            80,
            24,
            owner1,
        )
        .await
    });

    drop(ws1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    barrier.wait().await;
    host.runtime.terminals.set_open_barrier(None);

    let info = open_handle.await.unwrap().expect("open should succeed");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !host
            .runtime
            .terminals
            .owns(&TerminalOwner::Device(dev1_id.clone()), &info.id),
        "terminal opened across WS disconnect barrier must expire"
    );
    assert_eq!(host.runtime.terminals.session_count(), 0);

    // 2. Barrier between PTY start and commit_if while device scope is downgraded ->
    //    commit_if must reject with Forbidden and close the PTY (0 sessions left).
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    host.runtime
        .terminals
        .set_open_barrier(Some(Arc::clone(&barrier)));

    let runtime_clone = host.runtime.clone();
    let project_clone = project_id.clone();
    let owner1 = TerminalOwner::Device(dev1_id.clone());
    let open_handle = tokio::spawn(async move {
        crate::project_api::project_terminal_open_for_owner(
            &runtime_clone,
            project_clone,
            80,
            24,
            owner1,
        )
        .await
    });

    tokio::time::sleep(Duration::from_millis(80)).await;
    host.runtime
        .remote
        .set_device_scopes(&host.runtime, &dev1_id, RemoteScopes::Chat)
        .await
        .unwrap();
    barrier.wait().await;
    host.runtime.terminals.set_open_barrier(None);

    let err = open_handle
        .await
        .unwrap()
        .expect_err("downgraded device must be rejected at commit_if");
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(host.runtime.terminals.session_count(), 0);

    // 3. Barrier between PTY start and commit_if while the caller future is cancelled/dropped
    //    (e.g. remote switch disabled mid-flight) -> detached task must close the PTY and
    //    leave 0 sessions in TerminalManager.
    let (_token_dev2, dev2_id) = host.pair(RemoteScopes::ChatWorkspace, "BarrierDev2").await;
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    host.runtime
        .terminals
        .set_open_barrier(Some(Arc::clone(&barrier)));

    let runtime_clone = host.runtime.clone();
    let project_clone = project_id.clone();
    let owner2 = TerminalOwner::Device(dev2_id);
    let cancelled_open = tokio::spawn(async move {
        crate::project_api::project_terminal_open_for_owner(
            &runtime_clone,
            project_clone,
            80,
            24,
            owner2,
        )
        .await
    });

    tokio::time::sleep(Duration::from_millis(80)).await;
    cancelled_open.abort();
    let _ = cancelled_open.await;
    barrier.wait().await;
    host.runtime.terminals.set_open_barrier(None);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        host.runtime.terminals.session_count(),
        0,
        "cancelled terminal.open must close PTY and leave no registered session"
    );

    host.cleanup().await;
}

#[tokio::test]
async fn v2_binary_limits_enforce_terminal_write_1mib_and_blob_10mib() {
    let host = TestHost::start_with_local_projects("bin-limit").await;
    let project_dir = host.root.join("bin-limit-proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project_path = project_dir.to_string_lossy().to_string();

    let (token_ws, _) = host.pair(RemoteScopes::ChatWorkspace, "WsDev").await;
    let (token_chat, _) = host.pair(RemoteScopes::Chat, "ChatDev").await;

    let (status, added) = http_json(
        host.port,
        "POST",
        "/api/v2/call/project.add",
        Some(&token_ws),
        None,
        &json!({ "connectionId": "local", "path": project_path }),
    )
    .await;
    assert_eq!(status, 200);
    let project_id = added["result"]["id"].as_str().unwrap().to_owned();

    // 1. terminal.write > 1 MiB returns 413 with invalid_params for workspace device,
    //    and 403 forbidden for chat-only device.
    let oversized_write = vec![b'a'; host_api::MAX_TERMINAL_WRITE_BYTES + 1];
    let (status, body) = http_raw(
        host.port,
        "POST",
        "/api/v2/upload/terminal.write?terminalId=term-1",
        Some(&token_ws),
        None,
        Some("application/octet-stream"),
        &oversized_write,
    )
    .await;
    assert_eq!(status, 413);
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "invalid_params");

    let (status, body) = http_raw(
        host.port,
        "POST",
        "/api/v2/upload/terminal.write?terminalId=term-1",
        Some(&token_chat),
        None,
        Some("application/octet-stream"),
        &oversized_write,
    )
    .await;
    assert_eq!(status, 403);
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["error"]["code"], "forbidden");

    // Uploads to unknown or non-binary methods fail before the body is read,
    // so a body over every upload limit still gets the method error.
    let oversized_upload = vec![b'x'; host_api::MAX_BLOB_OUTPUT_BYTES + 1];
    for (path, expected_status, expected_code) in [
        ("/api/v2/upload/no.such.method", 404, "not_found"),
        ("/api/v2/upload/project.list", 400, "invalid_params"),
    ] {
        let (status, body) = http_raw(
            host.port,
            "POST",
            path,
            Some(&token_ws),
            None,
            Some("application/octet-stream"),
            &oversized_upload,
        )
        .await;
        assert_eq!(status, expected_status, "{path}");
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["error"]["code"], expected_code, "{path}");
    }

    // 2. session.historyImage returning > 10 MiB returns 413 with invalid_params.
    let pi_agent_dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join(".pi/agent"));
    let session_dir = pi_agent_dir
        .join("sessions")
        .join(format!("pilo-v2-blob-limit-{}", std::process::id()));
    std::fs::create_dir_all(&session_dir).unwrap();
    let session_path = session_dir.join("oversized-image-session.jsonl");
    let raw_image = vec![0xABu8; host_api::MAX_BLOB_OUTPUT_BYTES + 16];
    let encoded_image = BASE64.encode(&raw_image);
    let header = json!({
        "type": "session",
        "version": 3,
        "id": "oversized-img-session",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": project_path,
    });
    let entry = json!({
        "type": "message",
        "id": "m1",
        "parentId": null,
        "timestamp": "2026-01-01T00:00:01.000Z",
        "message": {
            "role": "user",
            "content": [
                { "type": "image", "mimeType": "image/png", "data": encoded_image }
            ]
        }
    });
    std::fs::write(&session_path, format!("{header}\n{entry}\n")).unwrap();
    let session_path_str = session_path.to_string_lossy().to_string();

    let (status, history) = http_json(
        host.port,
        "POST",
        "/api/v2/call/session.history",
        Some(&token_chat),
        None,
        &json!({ "projectId": project_id, "sessionPath": session_path_str }),
    )
    .await;
    assert_eq!(status, 200, "session.history failed: {history}");
    let image_id = "m1:0";

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("projectId", &project_id)
        .append_pair("sessionPath", &session_path_str)
        .append_pair("imageId", image_id)
        .finish();
    let (status, body) = http_raw(
        host.port,
        "GET",
        &format!("/api/v2/blob/session.historyImage?{query}"),
        Some(&token_chat),
        None,
        Some("application/octet-stream"),
        &[],
    )
    .await;
    let _ = std::fs::remove_dir_all(&session_dir);
    assert_eq!(status, 413);
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "invalid_params");

    host.cleanup().await;
}
