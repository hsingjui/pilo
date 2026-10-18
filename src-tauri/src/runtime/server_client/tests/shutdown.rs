use std::{
    cell::RefCell,
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pilo_protocol::{Envelope, PROTOCOL_VERSION, SERVER_CAPABILITIES, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::{io::BufReader, process::Command};

use crate::{
    domain::{Connection, ConnectionKind},
    runtime::{
        server_client::ServerManager,
        server_deploy::{SpawnedServer, TEST_SERVER},
    },
};

static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(1);

struct PendingServer {
    directory: PathBuf,
    server: Option<SpawnedServer>,
    pid: u32,
}

impl PendingServer {
    async fn new(reply_to_handshake: bool) -> Self {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/shutdown-tests")
            .join(format!(
                "pending-{}-{}-{}",
                std::process::id(),
                NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut handshake = Vec::new();
        write_frame(
            &mut handshake,
            Envelope::request(1, "server.ping", Value::Null),
        )
        .await
        .unwrap();
        let mut ping = Vec::new();
        write_frame(&mut ping, Envelope::request(2, "server.ping", Value::Null))
            .await
            .unwrap();
        let mut response = Vec::new();
        write_frame(
            &mut response,
            Envelope::response(
                1,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverVersion": "test",
                    "os": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                    "capabilities": SERVER_CAPABILITIES,
                }),
            ),
        )
        .await
        .unwrap();
        std::fs::write(directory.join("response"), response).unwrap();
        let after_handshake = if reply_to_handshake {
            format!(
                "cat \"$1/response\"; dd bs=1 count={} of=\"$1/ping\" 2>/dev/null; printf pending > \"$1/pending\"; cat >/dev/null; printf cleaned > \"$1/cleaned\"",
                ping.len()
            )
        } else {
            "printf pending > \"$1/pending\"; exec cat".to_owned()
        };
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                &format!(
                    "set -e; dd bs=1 count={} of=\"$1/handshake\" 2>/dev/null; {after_handshake}",
                    handshake.len()
                ),
                "sh",
            ])
            .arg(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let server = SpawnedServer {
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            stderr: child.stderr.take().unwrap(),
            child,
            reused_deployment: false,
        };
        Self {
            directory,
            server: Some(server),
            pid,
        }
    }

    async fn wait_for_request(&self, reply_to_handshake: bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.directory.join("pending").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("manager must reach the pending handshake or test ping");
        for (name, id) in [("handshake", 1)]
            .into_iter()
            .chain(reply_to_handshake.then_some(("ping", 2)))
        {
            let mut file = tokio::fs::File::open(self.directory.join(name))
                .await
                .unwrap();
            assert_eq!(
                read_frame(&mut file).await.unwrap().unwrap(),
                Envelope::request(id, "server.ping", Value::Null)
            );
        }
    }

    async fn assert_reaped(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let alive = Command::new("/bin/kill")
                    .args(["-0", &self.pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .unwrap()
                    .success();
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled manager operation must not leave its server launcher running");
    }
}

impl Drop for PendingServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

async fn assert_shutdown_cancels_manager_operation(
    test_connection: bool,
    reply_to_handshake: bool,
) {
    let mut server = PendingServer::new(reply_to_handshake).await;
    let manager = ServerManager::default();
    let connection = Connection {
        id: "shutdown-fixture".to_owned(),
        name: "Shutdown fixture".to_owned(),
        pi_executable: None,
        pi_runtime: Default::default(),
        kind: ConnectionKind::Local,
        shown_in_home: true,
    };
    TEST_SERVER
        .scope(RefCell::new(server.server.take()), async {
            let operation = async {
                if test_connection {
                    manager.test_connection(&connection).await.map(|_| ())
                } else {
                    manager.client(&connection).await.map(|_| ())
                }
            };
            tokio::pin!(operation);
            tokio::select! {
                result = &mut operation => panic!("operation finished before shutdown: {result:?}"),
                () = server.wait_for_request(reply_to_handshake) => {}
            }
            manager.begin_shutdown();
            let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
                tokio::join!(operation, manager.stop_all())
            })
            .await
            .expect("shutdown must cancel the real connect or test ping and finish cleanup");
            assert_eq!(result.unwrap_err(), "pilo-server manager is shutting down");
        })
        .await;
    server.assert_reaped().await;
    if reply_to_handshake {
        assert_eq!(
            std::fs::read_to_string(server.directory.join("cleaned")).unwrap(),
            "cleaned"
        );
    }
    assert_eq!(
        manager.client(&connection).await.err().unwrap(),
        "pilo-server manager is shutting down"
    );
}

#[tokio::test]
async fn shutdown_cancels_real_manager_connection_handshakes() {
    for test_connection in [false, true] {
        assert_shutdown_cancels_manager_operation(test_connection, false).await;
    }
}

#[tokio::test]
async fn shutdown_cancels_real_connection_test_ping_and_cleans_temporary_server() {
    assert_shutdown_cancels_manager_operation(true, true).await;
}
