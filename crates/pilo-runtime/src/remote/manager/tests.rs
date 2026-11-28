use super::*;
use crate::host_paths::HostPaths;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn gateway_enforces_configured_origins_and_never_rate_limits_device_tokens() {
    let root = std::env::temp_dir().join(format!(
        "pilo-remote-requests-{}-{}",
        std::process::id(),
        storage::now_ms()
    ));
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    runtime.remote.start(&runtime, 0).await.unwrap();
    let port = runtime.remote.snapshot(&runtime).await.unwrap().port;
    let request = |path, headers: &str| {
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{headers}\r\n");
        async move {
            let socket = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            let mut socket = BufReader::new(socket);
            socket.write_all(request.as_bytes()).await.unwrap();
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(2), socket.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            line.split_whitespace()
                .nth(1)
                .unwrap()
                .parse::<u16>()
                .unwrap()
        }
    };
    let addresses = vec![RemoteAccessAddress {
        id: "proxy".into(),
        name: String::new(),
        base_url: "https://remote.example.com".into(),
    }];
    runtime
        .remote
        .set_addresses(
            &runtime,
            RemoteAccessConfig {
                addresses,
                entry_address_id: "proxy".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(request("/api/v2/health", "").await, 200);
    for headers in [
        "Origin: https://remote.example.com\r\n",
        "Origin: HTTPS://REMOTE.EXAMPLE.COM\r\n",
        "Origin: https://remote.example.com:443\r\n",
    ] {
        assert_eq!(request("/api/v2/health", headers).await, 200);
    }
    for headers in [
        "Origin: https://remote.example.com:8080\r\n",
        "Origin: https://remote.example.com.evil.test\r\n",
        "Origin: https://remote.example.com/\r\n",
        "Origin: https://user@remote.example.com\r\n",
        "Origin: https://remote.example.com, https://evil.test\r\n",
        "Origin: null\r\n",
        "Origin: https://remote.example.com\r\nOrigin: https://evil.test\r\n",
    ] {
        assert_eq!(request("/api/v2/health", headers).await, 403);
    }
    // A stale token must keep seeing 401, however often it retries, so the
    // client knows to pair again instead of waiting out a 429.
    for _ in 0..8 {
        assert_eq!(request("/api/v1/auth/device", "").await, 401);
        assert_eq!(
            request("/api/v1/auth/device", "Authorization: Bearer invalid\r\n").await,
            401
        );
        assert_eq!(
            request(
                "/api/v1/auth/device",
                "Sec-WebSocket-Protocol: pilo, pilo-token.invalid\r\n"
            )
            .await,
            401
        );
    }
    let paired = super::super::auth::create_device(None, "127.0.0.1", RemoteScopes::Chat).unwrap();
    let db = storage::open_with_paths(&runtime.paths).unwrap();
    storage::insert_remote_device(
        &db,
        &paired.device,
        &super::super::auth::hash_credential(&paired.token),
    )
    .unwrap();
    drop(db);
    assert_eq!(
        request(
            "/api/v1/auth/device",
            &format!("Authorization: Bearer {}\r\n", paired.token),
        )
        .await,
        200
    );
    runtime.remote.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn disabling_gateway_cancels_an_in_flight_http_call() {
    let root = std::env::temp_dir().join(format!(
        "pilo-remote-cancel-{}-{}",
        std::process::id(),
        storage::now_ms()
    ));
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    runtime.remote.start(&runtime, 0).await.unwrap();
    let port = runtime.remote.snapshot(&runtime).await.unwrap().port;
    let socket = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    let mut socket = BufReader::new(socket);
    socket.write_all(b"POST /api/v1/auth/pairing HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 30\r\nExpect: 100-continue\r\n\r\n").await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(2), socket.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line.trim(), "HTTP/1.1 100 Continue");
    assert!(
        !runtime
            .remote
            .set_enabled(&runtime, false)
            .await
            .unwrap()
            .running
    );
    line.clear();
    tokio::time::timeout(Duration::from_secs(2), socket.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, "\r\n");
    line.clear();
    tokio::time::timeout(Duration::from_secs(2), socket.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line.trim(), "HTTP/1.1 503 Service Unavailable");
    assert!(
        tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .is_err()
    );
    runtime.remote.start(&runtime, port).await.unwrap();
    assert!(
        tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok()
    );
    runtime.remote.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn pair_scope_is_cached_until_runtime_scope_update_and_revocation() {
    let root = std::env::temp_dir().join(format!(
        "pilo-remote-scopes-{}-{}",
        std::process::id(),
        storage::now_ms()
    ));
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    runtime.remote.start(&runtime, 0).await.unwrap();
    runtime
        .remote
        .regenerate_pairing(&runtime, RemoteScopes::ChatWorkspace)
        .await
        .unwrap();
    let (pairing, generation) = {
        let inner = runtime.remote.inner.lock().await;
        let running = inner.running.as_ref().unwrap();
        (running.pairing.clone(), running.auth_generation.subscribe())
    };
    let (secret, info) = pairing.snapshot().unwrap();
    assert_eq!(info.scopes, RemoteScopes::ChatWorkspace);
    let paired = pairing
        .exchange(
            &runtime.paths,
            &secret,
            &info.addresses[0].address.id,
            &"a".repeat(64),
            None,
            "127.0.0.1",
        )
        .ok()
        .unwrap();
    let authenticate = || {
        super::super::auth::authenticate_cached(&runtime.paths, &paired.token, *generation.borrow())
            .unwrap()
    };
    assert_eq!(authenticate().unwrap().scopes, RemoteScopes::ChatWorkspace);
    let snapshot = runtime
        .remote
        .set_device_scopes(&runtime, &paired.device.id, RemoteScopes::Chat)
        .await
        .unwrap();
    assert!(generation.has_changed().unwrap());
    assert_eq!(snapshot.devices[0].scopes, RemoteScopes::Chat);
    assert_eq!(authenticate().unwrap().scopes, RemoteScopes::Chat);
    runtime.remote.set_enabled(&runtime, false).await.unwrap();
    runtime.remote.start(&runtime, 0).await.unwrap();
    let current_generation = {
        let inner = runtime.remote.inner.lock().await;
        inner.running.as_ref().unwrap().auth_generation.subscribe()
    };
    let check_current = || {
        super::super::auth::authenticate_cached(
            &runtime.paths,
            &paired.token,
            *current_generation.borrow(),
        )
        .unwrap()
    };
    assert_eq!(check_current().unwrap().scopes, RemoteScopes::Chat);
    let cleared = runtime.remote.revoke_all_devices(&runtime).await.unwrap();
    assert!(cleared.running);
    assert!(cleared.pairing_url.is_none());
    assert!(
        cleared
            .devices
            .iter()
            .all(|device| device.revoked_at_ms.is_some())
    );
    assert!(check_current().is_none());
    runtime.remote.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn live_websocket_reauthenticates_after_scope_change_and_closes_on_revocation() {
    let root = std::env::temp_dir().join(format!(
        "pilo-remote-ws-auth-{}-{}",
        std::process::id(),
        storage::now_ms()
    ));
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    runtime.remote.start(&runtime, 0).await.unwrap();
    let port = runtime.remote.snapshot(&runtime).await.unwrap().port;
    let paired =
        super::super::auth::create_device(None, "127.0.0.1", RemoteScopes::ChatWorkspace).unwrap();
    let db = storage::open_with_paths(&runtime.paths).unwrap();
    storage::insert_remote_device(
        &db,
        &paired.device,
        &super::super::auth::hash_credential(&paired.token),
    )
    .unwrap();

    let upgrade = format!(
        "GET /api/v2/events HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n\
             Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Protocol: pilo, pilo-token.{}\r\n\r\n",
        paired.token
    );
    let timeout = Duration::from_secs(3);
    let connect = || async {
        let mut socket = BufReader::new(
            tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap(),
        );
        socket.write_all(upgrade.as_bytes()).await.unwrap();
        let hello = tokio::time::timeout(timeout, async {
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            assert_eq!(line.trim(), "HTTP/1.1 101 Switching Protocols");
            loop {
                line.clear();
                assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
            }
            let mut header = [0; 2];
            socket.read_exact(&mut header).await.unwrap();
            assert_eq!(header[0], 0x81);
            assert_eq!(header[1], 126);
            let length = socket.read_u16().await.unwrap();
            let mut payload = vec![0; usize::from(length)];
            socket.read_exact(&mut payload).await.unwrap();
            let hello: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(hello["type"], "hello");
            assert_eq!(hello["deviceId"], paired.device.id);
            hello
        })
        .await
        .unwrap();
        (socket, hello)
    };
    let (mut socket, hello) = connect().await;
    assert_eq!(hello["scopes"], "chat,workspace");

    // Only socket reauthentication can touch this timestamp before the 15 s auth tick.
    db.execute(
        "UPDATE remote_devices SET last_seen_at_ms = 0 WHERE id = ?1",
        [&paired.device.id],
    )
    .unwrap();
    runtime
        .remote
        .set_device_scopes(&runtime, &paired.device.id, RemoteScopes::Chat)
        .await
        .unwrap();
    tokio::time::timeout(timeout, async {
        loop {
            let devices = storage::list_remote_devices(&db).unwrap();
            assert_eq!(devices[0].scopes, RemoteScopes::Chat);
            if devices[0].last_seen_at_ms != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("scope update did not trigger WebSocket reauthentication");

    let mut frame = [0; 2];
    tokio::time::timeout(timeout, socket.read_exact(&mut frame))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame, [0x88, 0]);
    let (mut socket, hello) = connect().await;
    assert_eq!(hello["scopes"], "chat");
    // An empty masked Ping must get a Pong on the renegotiated stream.
    socket.write_all(&[0x89, 0x80, 1, 2, 3, 4]).await.unwrap();
    tokio::time::timeout(timeout, socket.read_exact(&mut frame))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame, [0x8a, 0]);
    let revoked = runtime.remote.revoke_all_devices(&runtime).await.unwrap();
    assert!(revoked.running);
    tokio::time::timeout(timeout, socket.read_exact(&mut frame))
        .await
        .expect("revoked WebSocket did not close before the periodic auth tick")
        .unwrap();
    assert_eq!(frame, [0x88, 0]);
    drop(db);
    runtime.remote.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn dropping_runtime_stops_remote_listener_without_shutdown() {
    use crate::{Runtime, host_paths::HostPaths};
    let root = std::env::temp_dir().join(format!(
        "pilo-remote-drop-{}-{}",
        std::process::id(),
        super::storage::now_ms()
    ));
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    runtime.remote.start(&runtime, 0).await.unwrap();
    let task = {
        let inner = runtime.remote.inner.lock().await;
        let running = inner.running.as_ref().unwrap();
        running.task.abort_handle()
    };
    let weak = runtime.downgrade();
    drop(runtime);
    assert!(weak.upgrade().is_err());
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn changing_addresses_keeps_the_pairing_scope() {
    let root = std::env::temp_dir().join(format!(
        "pilo-remote-address-scope-{}-{}",
        std::process::id(),
        storage::now_ms()
    ));
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    runtime.remote.start(&runtime, 0).await.unwrap();
    runtime
        .remote
        .regenerate_pairing(&runtime, RemoteScopes::ChatWorkspace)
        .await
        .unwrap();
    let state = runtime
        .remote
        .set_addresses(
            &runtime,
            RemoteAccessConfig {
                addresses: vec![RemoteAccessAddress {
                    id: "proxy".into(),
                    name: String::new(),
                    base_url: "https://remote.example.com".into(),
                }],
                entry_address_id: "proxy".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(state.pairing_scopes, Some(RemoteScopes::ChatWorkspace));
    runtime.remote.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn effective_base_url_prefers_configured_public_url() {
    assert_eq!(
        effective_base_url("https://dev.example.com", "http://192.168.1.5:47653"),
        "https://dev.example.com"
    );
    assert_eq!(
        effective_base_url("", "http://192.168.1.5:47653"),
        "http://192.168.1.5:47653"
    );
    assert_eq!(
        effective_base_url("  ", "http://192.168.1.5:47653"),
        "http://192.168.1.5:47653"
    );
}

#[test]
fn access_base_url_validates_and_trims() {
    assert_eq!(
        access::normalize_base_url("https://dev.example.com/"),
        Ok("https://dev.example.com".to_owned())
    );
    assert_eq!(
        access::normalize_base_url("http://dev.example.com:8080"),
        Ok("http://dev.example.com:8080".to_owned())
    );
    assert!(access::normalize_base_url("dev.example.com").is_err());
}
