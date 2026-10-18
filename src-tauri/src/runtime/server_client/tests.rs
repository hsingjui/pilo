use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};

use super::transport::{
    PendingRequest, PendingRequests, ServerEvent, ServerEventHub, mark_disconnected,
};
use super::{SERVER_DISCONNECTED_EVENT, manager::retryable_read_method};
use crate::domain::{Connection, ConnectionKind};
use crate::runtime::server_client::manager::ServerManager;
use crate::runtime::server_deploy::{
    ServerArch, ServerPlatform, ServerTarget, installed_server_candidates, parse_target_probe,
    server_binary,
};

const LINUX_X86_64: ServerTarget = ServerTarget {
    platform: ServerPlatform::Linux,
    arch: ServerArch::X86_64,
};
const LINUX_AARCH64: ServerTarget = ServerTarget {
    platform: ServerPlatform::Linux,
    arch: ServerArch::Aarch64,
};

#[cfg(unix)]
#[tokio::test]
async fn stop_closes_stdin_and_allows_server_child_cleanup_before_exit() {
    use super::{
        ServerClient,
        transport::{ServerProcess, reader_loop, writer_loop},
    };
    use std::{
        process::Stdio,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::{io::BufReader, process::Command};

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/shutdown-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join(format!(
        "cleanup-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut child = Command::new("/bin/sh")
        .args(["-c", "cat >/dev/null; printf cleaned > \"$1\"", "sh"])
        .arg(&marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (writer, requests) = mpsc::channel(1);
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let events = Arc::new(ServerEventHub::default());
    let closed = Arc::new(AtomicBool::new(false));
    let writer_task = tokio::spawn(writer_loop(
        stdin,
        requests,
        Arc::clone(&pending),
        Arc::clone(&events),
        Arc::clone(&closed),
    ));
    let reader_task = tokio::spawn(reader_loop(
        BufReader::new(stdout),
        Arc::clone(&pending),
        Arc::clone(&events),
        Arc::clone(&closed),
    ));
    let client = ServerClient {
        request_id: Default::default(),
        writer,
        pending,
        events,
        process: Mutex::new(Some(ServerProcess {
            child,
            writer_task,
            reader_task,
        })),
        closed,
    };
    client.stop().await;
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "cleaned");
    std::fs::remove_file(marker).unwrap();
}

#[test]
fn bundled_server_targets_have_stable_resource_names() {
    let cases = [
        (
            ServerTarget {
                platform: ServerPlatform::Windows,
                arch: ServerArch::X86_64,
            },
            "pilo-server-windows-x86_64.exe",
        ),
        (LINUX_X86_64, "pilo-server-linux-x86_64"),
        (LINUX_AARCH64, "pilo-server-linux-aarch64"),
        (
            ServerTarget {
                platform: ServerPlatform::Darwin,
                arch: ServerArch::Aarch64,
            },
            "pilo-server-darwin-aarch64",
        ),
    ];
    for (target, expected) in cases {
        assert_eq!(target.resource_name().unwrap(), expected);
    }

    assert!(
        ServerTarget {
            platform: ServerPlatform::Windows,
            arch: ServerArch::Aarch64,
        }
        .resource_name()
        .is_err()
    );
    assert!(
        ServerTarget {
            platform: ServerPlatform::Darwin,
            arch: ServerArch::X86_64,
        }
        .resource_name()
        .is_err()
    );
}

#[test]
fn platform_probe_maps_linux_and_macos_architectures() {
    assert_eq!(
        parse_target_probe(b"Linux\tx86_64\n", "test").unwrap(),
        LINUX_X86_64
    );
    assert_eq!(
        parse_target_probe(b"Linux\taarch64\n", "test").unwrap(),
        LINUX_AARCH64
    );
    assert_eq!(
        parse_target_probe(b"Darwin\tarm64\n", "test").unwrap(),
        ServerTarget {
            platform: ServerPlatform::Darwin,
            arch: ServerArch::Aarch64,
        }
    );
    assert!(parse_target_probe(b"Darwin\tx86_64\n", "test").is_err());
    assert!(parse_target_probe(b"FreeBSD\tx86_64\n", "test").is_err());
    assert!(parse_target_probe(b"Linux\triscv64\n", "test").is_err());
}

#[test]
fn current_platform_resolves_its_server_runtime() {
    let target = ServerTarget::current().unwrap();
    let path = match server_binary(target) {
        Ok(path) => path,
        Err(error) if cfg!(debug_assertions) => {
            // Local debug embeds the server; a standalone dev build is optional.
            assert_eq!(
                error,
                format!(
                    "development pilo-server runtime '{}' is missing; run pnpm server:build with the remote platform target, then restart Pilo",
                    target.resource_name().unwrap()
                )
            );
            return;
        }
        Err(error) => panic!("{error}"),
    };
    assert!(path.is_file());
    let expected_name = if cfg!(debug_assertions) {
        if target.platform == ServerPlatform::Windows {
            "pilo-server.exe"
        } else {
            "pilo-server"
        }
    } else {
        target.resource_name().unwrap()
    };
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some(expected_name)
    );
}

#[test]
fn installed_runtime_candidates_cover_bundle_layouts() {
    let name = "pilo-server-linux-x86_64";
    assert_eq!(
        installed_server_candidates(Path::new("/install/Pilo.exe"), None, name)[0],
        Path::new("/install/runtime/pilo-server-linux-x86_64")
    );
    assert_eq!(
        installed_server_candidates(
            Path::new("/Applications/Pilo.app/Contents/MacOS/pilo"),
            None,
            name
        )[1],
        Path::new(
            "/Applications/Pilo.app/Contents/MacOS/../Resources/runtime/pilo-server-linux-x86_64"
        )
    );
    assert_eq!(
        installed_server_candidates(
            Path::new("/usr/bin/pilo"),
            Some(Path::new("/usr/lib/Pilo")),
            name
        )[0],
        Path::new("/usr/lib/Pilo/runtime/pilo-server-linux-x86_64")
    );
    assert_eq!(
        installed_server_candidates(
            Path::new("/tmp/.mount_Pilo/usr/bin/pilo"),
            Some(Path::new("/tmp/.mount_Pilo/usr/lib/Pilo")),
            name
        )[0],
        Path::new("/tmp/.mount_Pilo/usr/lib/Pilo/runtime/pilo-server-linux-x86_64")
    );
}

#[tokio::test]
async fn disconnect_fails_pending_requests_and_notifies_subscribers() {
    let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let (reply_tx, reply_rx) = oneshot::channel();
    pending
        .lock()
        .await
        .insert(42, PendingRequest { reply: reply_tx });
    let events = ServerEventHub::default();
    let mut subscriber = events.subscribe("pi:test");
    let closed = AtomicBool::new(false);

    mark_disconnected(&pending, &events, &closed, "transport lost".to_owned()).await;

    assert!(closed.load(Ordering::Acquire));
    assert!(matches!(
        reply_rx.await.unwrap(),
        Err(error) if error == "transport lost"
    ));
    let event = subscriber.recv().await.unwrap();
    assert_eq!(event.event, SERVER_DISCONNECTED_EVENT);
    assert_eq!(event.stream_id, "");
    assert_eq!(event.data, json!({ "message": "transport lost" }));
}

#[tokio::test]
async fn event_hub_routes_only_to_matching_stream() {
    let events = ServerEventHub::default();
    let mut first = events.subscribe("stream:first");
    let mut second = events.subscribe("stream:second");

    events.send(ServerEvent {
        stream_id: "stream:first".to_owned(),
        event: "terminal.output".to_owned(),
        data: Value::Null,
        binary: vec![vec![1, 2, 3]],
    });

    let event = first.recv().await.unwrap();
    assert_eq!(event.stream_id, "stream:first");
    assert_eq!(event.binary, vec![vec![1, 2, 3]]);
    assert!(matches!(
        second.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn event_hub_preserves_large_interleaved_stream_bursts() {
    let events = ServerEventHub::default();
    let mut first = events.subscribe("stream:first");
    let mut second = events.subscribe("stream:second");
    const EVENT_COUNT: usize = 2_048;

    for index in 0..EVENT_COUNT {
        for stream_id in ["stream:first", "stream:second"] {
            events.send(ServerEvent {
                stream_id: stream_id.to_owned(),
                event: "pi.rpc".to_owned(),
                data: json!({ "index": index }),
                binary: Vec::new(),
            });
        }
    }

    for index in 0..EVENT_COUNT {
        let first_event = first.recv().await.unwrap();
        let second_event = second.recv().await.unwrap();
        assert_eq!(first_event.data, json!({ "index": index }));
        assert_eq!(second_event.data, json!({ "index": index }));
    }
}

#[tokio::test]
async fn event_hub_disconnects_a_stream_when_its_buffer_overflows() {
    let events = ServerEventHub::default();
    let mut subscriber = events.subscribe("stream:overflow");
    const EVENT_COUNT: usize = 2_048;

    for index in 0..=EVENT_COUNT {
        events.send(ServerEvent {
            stream_id: "stream:overflow".to_owned(),
            event: "pi.rpc".to_owned(),
            data: json!({ "index": index }),
            binary: Vec::new(),
        });
    }

    for index in 0..EVENT_COUNT {
        let event = subscriber.recv().await.unwrap();
        assert_eq!(event.data, json!({ "index": index }));
    }

    let overflow = subscriber.recv().await.unwrap();
    assert_eq!(overflow.event, SERVER_DISCONNECTED_EVENT);
    assert_eq!(overflow.stream_id, "stream:overflow");
    assert_eq!(
        overflow.data,
        json!({
            "message": "server event stream overflowed",
            "overflow": true,
        })
    );
    assert!(subscriber.recv().await.is_none());
}

#[tokio::test]
async fn resubscribing_stream_closes_the_stale_receiver() {
    let events = ServerEventHub::default();
    let mut stale = events.subscribe("pi:test");
    let mut current = events.subscribe("pi:test");

    assert!(stale.recv().await.is_none());

    events.send(ServerEvent {
        stream_id: "pi:test".to_owned(),
        event: "pi.rpc".to_owned(),
        data: json!({ "type": "agent_settled" }),
        binary: Vec::new(),
    });

    let event = current.recv().await.unwrap();
    assert_eq!(event.event, "pi.rpc");
    assert_eq!(event.data, json!({ "type": "agent_settled" }));
}

#[tokio::test]
async fn shutdown_gate_rejects_new_server_connections() {
    let manager = ServerManager::default();
    let connection = Connection {
        id: "local".to_owned(),
        name: "Local".to_owned(),
        pi_executable: None,
        pi_runtime: Default::default(),
        kind: ConnectionKind::Local,
        shown_in_home: true,
    };

    manager.stop_all().await;

    let error = manager
        .request(&connection, "fs.read_file", Value::Null)
        .await
        .unwrap_err();
    assert_eq!(error, "pilo-server manager is shutting down");
}

#[test]
fn reconnect_retry_is_limited_to_read_only_methods() {
    for method in [
        "server.status",
        "environment.inspect",
        "fs.read_file",
        "fs.search",
        "session.scan",
        "session.search",
        "session.read",
        "preview.ports",
    ] {
        assert!(
            retryable_read_method(method),
            "{method} should be retryable"
        );
    }
    for method in [
        "command.run",
        "fs.write_file",
        "fs.rename",
        "fs.remove",
        "session.delete",
        "session.watch_start",
        "terminal.open",
        "pi.start",
        "pi.send",
    ] {
        assert!(
            !retryable_read_method(method),
            "{method} must not be replayed"
        );
    }
}
