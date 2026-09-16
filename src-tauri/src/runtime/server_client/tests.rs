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
fn current_platform_resolves_its_staged_server_runtime() {
    let target = ServerTarget::current().unwrap();
    let path = server_binary(target).unwrap();
    assert!(path.is_file());
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some(target.resource_name().unwrap())
    );
}

#[test]
fn installed_runtime_candidates_cover_bundle_layouts() {
    let name = "pilo-server-linux-x86_64";
    assert_eq!(
        installed_server_candidates(Path::new("/install/Pilo.exe"), name)[0],
        Path::new("/install/runtime/pilo-server-linux-x86_64")
    );
    assert_eq!(
        installed_server_candidates(
            Path::new("/Applications/Pilo.app/Contents/MacOS/pilo"),
            name
        )[1],
        Path::new(
            "/Applications/Pilo.app/Contents/MacOS/../Resources/runtime/pilo-server-linux-x86_64"
        )
    );
    assert_eq!(
        installed_server_candidates(Path::new("/usr/bin/pilo"), name)[2],
        Path::new("/usr/bin/../lib/pilo/runtime/pilo-server-linux-x86_64")
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
