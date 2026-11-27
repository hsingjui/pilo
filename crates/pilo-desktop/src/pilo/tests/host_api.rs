use std::net::{SocketAddr, TcpListener};

use http_body_util::{BodyExt, Full};
use hyper::{Request, body::Bytes, header};
use hyper_util::rt::TokioIo;

use super::{Instance, Pilo, Project, ProjectMetadata, storage};
use crate::pilo::HostPaths;
use serde_json::{Value, json};

async fn request(
    addr: SocketAddr,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (u16, Value) {
    let body = body.map(|body| ("application/json", Bytes::from(body.to_string())));
    let (status, body) = request_bytes(addr, path, body, token).await;
    (status, serde_json::from_slice(&body).unwrap())
}

async fn request_bytes(
    addr: SocketAddr,
    path: &str,
    body: Option<(&str, Bytes)>,
    token: Option<&str>,
) -> (u16, Bytes) {
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    let task = tokio::spawn(connection);
    let mut request = Request::builder()
        .uri(path)
        .header(header::HOST, addr.to_string());
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = if let Some((mime_type, body)) = body {
        request = request
            .method("POST")
            .header(header::CONTENT_TYPE, mime_type);
        body
    } else {
        Bytes::new()
    };
    let response = sender
        .send_request(request.body(Full::new(body)).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    drop(sender);
    task.await.unwrap().unwrap();
    (status, body)
}

async fn enable_and_pair(pilo: &Instance<Pilo>) -> (SocketAddr, String) {
    let addr = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    Pilo::remote_set_port(pilo.clone(), f64::from(addr.port()))
        .await
        .unwrap();
    let remote = Pilo::remote_set_enabled(pilo.clone(), true).await.unwrap();
    let secret = remote["pairingUrl"]
        .as_str()
        .unwrap()
        .split_once("#pair=")
        .unwrap()
        .1;
    let (status, paired) = request(
        addr,
        "/api/v1/auth/pair",
        Some(json!({
            "secret": secret,
            "addressId": remote["entryAddressId"],
            "requestId": "1".repeat(64),
            "deviceName": "Registry parity test",
        })),
        None,
    )
    .await;
    assert_eq!(status, 200);
    (addr, paired["token"].as_str().unwrap().into())
}

const PROJECT_ID: &str = "saved-project";

fn project_host(data: &std::path::Path, pi: Option<String>) -> Instance<Pilo> {
    let paths = HostPaths::new(data.into(), data.into()).unwrap();
    let db = storage::open(&paths).unwrap();
    let path = data.to_string_lossy().into_owned();
    let mut connection = storage::ensure_local_connection(&db).unwrap();
    connection.pi_executable = pi;
    storage::upsert_connection(&db, &connection).unwrap();
    storage::upsert_project(
        &db,
        &Project {
            id: PROJECT_ID.into(),
            name: "Saved project".into(),
            path: path.clone(),
            connection,
            metadata: ProjectMetadata {
                cwd: path.clone(),
                git_branch: None,
                pi_version: "test".into(),
                refreshed_at_ms: 1,
            },
            created_at_ms: 1,
            last_opened_at_ms: 1,
        },
    )
    .unwrap();
    drop(db);
    Instance::new(Pilo::new(Some(path), None).unwrap())
}

#[test]
fn native_calls_match_authenticated_v1_routes() {
    let data = tempfile::tempdir().unwrap();
    let pilo = project_host(data.path(), None);
    let executor = pilo.with(|pilo| pilo.executor);
    executor.block_on(async {
        let (addr, token) = enable_and_pair(&pilo).await;
        let token = Some(token.as_str());

        let prefs = Pilo::save_preferences(pilo.clone(), json!({"locale": "zh-CN"}), None)
            .await
            .unwrap();
        let (status, body) = request(addr, "/api/v1/preferences", None, token).await;
        assert_eq!(
            (status, body),
            (
                200,
                json!({"revision": prefs.revision, "values": prefs.values})
            )
        );

        let native_sessions =
            Pilo::list_sessions(pilo.clone(), PROJECT_ID.into(), Some(true), None)
                .await
                .unwrap();
        let (status, body) = request(
            addr,
            "/api/v1/sessions?projectId=saved-project&cached=true",
            None,
            token,
        )
        .await;
        assert_eq!((status, body), (200, json!(native_sessions)));

        let command = json!({"type": "prompt", "message": "hello", "images": vec![Value::Null; 9]});
        let error = Pilo::send_chat_command(pilo.clone(), "test".into(), command.clone())
            .await
            .unwrap_err();
        assert_eq!(error, "at most 8 images can be sent at once");
        let (status, body) = request(
            addr,
            "/api/v1/chat/rpc",
            Some(json!({"sessionKey":"test","command":command})),
            token,
        )
        .await;
        assert_eq!((status, body), (400, json!({"error": error})));

        let error = Pilo::read_project_image(pilo.clone(), "missing".into(), "image.png".into())
            .await
            .unwrap_err();
        let (status, body) = request(
            addr,
            "/api/v1/files/image?projectId=missing&path=image.png",
            None,
            token,
        )
        .await;
        assert_eq!((status, body), (404, json!({"error": error})));

        Pilo::shutdown(pilo).await.unwrap();
    });
}

#[cfg(unix)]
#[test]
fn native_and_v1_send_read_and_upload() {
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

    use crate::pilo::{NativeHistoryOptions, NativeStartChatInput};

    const FIXTURE_ROOT: &str = "PILO_HOST_API_TEST_ROOT";
    let Some(root) = std::env::var_os(FIXTURE_ROOT) else {
        // A dedicated test process gives pilo-server isolated Pi and runtime
        // directories without changing environment variables in parallel tests.
        let root = tempfile::tempdir().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pilo::tests::host_api::native_and_v1_send_read_and_upload",
                "--nocapture",
            ])
            .env(FIXTURE_ROOT, root.path())
            .env("PI_CODING_AGENT_DIR", root.path().join("pi-agent"))
            .env(
                "PILO_SERVER_RUNTIME_DIR",
                root.path().join("server-runtime"),
            )
            .status()
            .unwrap();
        assert!(status.success());
        return;
    };
    let root = PathBuf::from(root);
    let pi = root.join("pi.sh");
    fs::write(&pi, r#"#!/bin/sh
if [ "$1" = "--version" ]; then
    printf '%s\n' '0.0.0'
    exit
fi
while IFS= read -r command; do
    case "$command" in
        *'"pilo-session-init"'*) printf '%s\n' '{"type":"response","command":"get_state","id":"pilo-session-init","success":true}' ;;
        *'"pilo-session-prepare"'*) printf '%s\n' '{"type":"response","command":"get_state","id":"pilo-session-prepare","success":true}' ;;
        *'"type":"prompt"'*) printf '%s\n' "$command" >> "${0%/*}/received-prompts" ;;
    esac
done
"#).unwrap();
    fs::set_permissions(&pi, fs::Permissions::from_mode(0o700)).unwrap();

    let sessions = root.join("pi-agent/sessions");
    fs::create_dir_all(&sessions).unwrap();
    let session = sessions.join("parity.jsonl");
    fs::write(&session, concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"test\"}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"u1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"second\"},{\"type\":\"image\",\"data\":\"AQID\",\"mimeType\":\"image/png\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"u3\",\"parentId\":\"u2\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"third\"}]}}\n",
    )).unwrap();
    let session_path = session.to_str().unwrap();
    let history_query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("projectId", PROJECT_ID)
        .append_pair("sessionPath", session_path)
        .finish();
    let pilo = project_host(&root, Some(pi.to_str().unwrap().into()));
    let executor = pilo.with(|pilo| pilo.executor);
    executor.block_on(async {
        let (addr, token) = enable_and_pair(&pilo).await;
        let token = Some(token.as_str());
        Pilo::start_chat(
            pilo.clone(),
            NativeStartChatInput {
                project_id: PROJECT_ID.into(),
                session_key: "native".into(),
                session_path: None,
                no_session: Some(true),
                builtin_extensions: None,
            },
        )
        .await
        .unwrap();
        Pilo::send_chat_command(
            pilo.clone(),
            "native".into(),
            json!({"type":"prompt","message":"from native"}),
        )
        .await
        .unwrap();
        let (status, snapshot) = request(
            addr,
            "/api/v1/chat/start",
            Some(json!({
                "projectId": PROJECT_ID, "sessionKey":"web", "noSession":true
            })),
            token,
        )
        .await;
        assert_eq!(status, 200, "{snapshot}");
        let (status, _) = request_bytes(
            addr,
            "/api/v1/chat/rpc",
            Some((
                "application/json",
                Bytes::from(
                    json!({"sessionKey":"web","command":{"type":"prompt","message":"from web"}})
                        .to_string(),
                ),
            )),
            token,
        )
        .await;
        assert_eq!(status, 204);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let receipts =
                    fs::read_to_string(root.join("received-prompts")).unwrap_or_default();
                if receipts.contains("from native") && receipts.contains("from web") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("both prompts should reach Pi");

        for (start, expected) in [(0, "first"), (1, "second"), (2, "third")] {
            let native = Pilo::load_history(
                pilo.clone(),
                PROJECT_ID.into(),
                session_path.into(),
                Some(NativeHistoryOptions {
                    start_message: Some(f64::from(start)),
                    message_limit: Some(1.0),
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            let (status, web) = request(
                addr,
                &format!("/api/v1/history?{history_query}&startMessage={start}&messageLimit=1"),
                None,
                token,
            )
            .await;
            assert_eq!((status, &web), (200, &native));
            assert_eq!(web["history"]["windowStartMessage"], start);
            assert_eq!(web["history"]["windowMessageCount"], 1);
            assert_eq!(web["history"]["totalMessages"], 3);
            assert_eq!(web["history"]["events"][0]["text"], expected);
        }
        let native = Pilo::read_history_image(
            pilo.clone(),
            PROJECT_ID.into(),
            session_path.into(),
            "u2:1".into(),
            None,
        )
        .await
        .unwrap();
        let (status, web) = request_bytes(
            addr,
            &format!("/api/v1/history/image?{history_query}&imageId=u2%3A1"),
            None,
            token,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(native, [1, 2, 3]);
        assert_eq!(web.as_ref(), native);

        const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
        for length in [MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES + 1] {
            let data = vec![0x5a; length];
            let native = Pilo::upload_chat_file(
                pilo.clone(),
                PROJECT_ID.into(),
                "parity.bin".into(),
                data.clone(),
            )
            .await;
            let (status, body) = request_bytes(
                addr,
                "/api/v1/chat/files?projectId=saved-project&name=parity.bin",
                Some(("application/octet-stream", Bytes::from(data.clone()))),
                token,
            )
            .await;
            if length == MAX_ATTACHMENT_BYTES {
                let native = native.unwrap();
                assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
                let web: String = serde_json::from_slice(&body).unwrap();
                for path in [native, web] {
                    assert_eq!(fs::read(&path).unwrap(), data);
                    Pilo::remove_chat_file(pilo.clone(), PROJECT_ID.into(), path)
                        .await
                        .unwrap();
                }
            } else {
                assert_eq!(
                    native.unwrap_err(),
                    "chat attachment exceeds the 10 MB limit"
                );
                assert_eq!(status, 413);
            }
        }
        Pilo::shutdown(pilo).await.unwrap();
    });
}
