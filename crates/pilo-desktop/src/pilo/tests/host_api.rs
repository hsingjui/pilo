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
    let body = if let Some(body) = body {
        request = request
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json");
        Bytes::from(body.to_string())
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
    (status, serde_json::from_slice(&body).unwrap())
}

#[test]
fn native_calls_match_authenticated_v1_routes() {
    let data = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(data.path().into(), data.path().into()).unwrap();
    let db = storage::open(&paths).unwrap();
    let project_id = "saved-project";
    let path = data.path().to_string_lossy().into_owned();
    storage::upsert_project(
        &db,
        &Project {
            id: project_id.into(),
            name: "Saved project".into(),
            path: path.clone(),
            connection: storage::ensure_local_connection(&db).unwrap(),
            metadata: ProjectMetadata {
                cwd: path,
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

    let addr = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let pilo = Instance::new(Pilo::new(Some(data.path().to_str().unwrap().into()), None).unwrap());
    let executor = pilo.with(|pilo| pilo.executor);
    executor.block_on(async {
        Pilo::remote_set_port(pilo.clone(), f64::from(addr.port()))
            .await
            .unwrap();
        let remote = Pilo::remote_set_enabled(pilo.clone(), true).await.unwrap();
        let pairing_url = remote["pairingUrl"].as_str().unwrap();
        let secret = pairing_url.split_once("#pair=").unwrap().1;
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
        let token = paired["token"].as_str().unwrap();

        let prefs = Pilo::save_preferences(pilo.clone(), json!({"locale": "zh-CN"}), None)
            .await
            .unwrap();
        let (status, body) = request(addr, "/api/v1/preferences", None, Some(token)).await;
        assert_eq!(
            (status, body),
            (
                200,
                json!({"revision": prefs.revision, "values": prefs.values})
            )
        );

        let native_sessions =
            Pilo::list_sessions(pilo.clone(), project_id.into(), Some(true), None)
                .await
                .unwrap();
        let (status, body) = request(
            addr,
            "/api/v1/sessions?projectId=saved-project&cached=true",
            None,
            Some(token),
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
            Some(token),
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
            Some(token),
        )
        .await;
        assert_eq!((status, body), (404, json!({"error": error})));

        Pilo::shutdown(pilo).await.unwrap();
    });
}
