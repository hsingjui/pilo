use std::process::Stdio;

use pilo_protocol::{Envelope, PROTOCOL_VERSION, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::process::Command;

#[tokio::test]
async fn stdio_server_speaks_protobuf_and_preserves_binary_bytes() {
    let executable = env!("CARGO_BIN_EXE_pilo-server");
    let mut child = Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("failed to spawn pilo-server");
    let mut stdin = child.stdin.take().expect("missing server stdin");
    let mut stdout = child.stdout.take().expect("missing server stdout");

    write_frame(&mut stdin, &Envelope::request(1, "hello", Value::Null))
        .await
        .unwrap();
    let hello = read_frame(&mut stdout).await.unwrap().unwrap();
    let Envelope::Response {
        id,
        result: Some(result),
        binary,
        error: None,
    } = hello
    else {
        panic!("unexpected hello response: {hello:?}");
    };
    assert_eq!(id, 1);
    assert!(binary.is_empty());
    assert_eq!(
        result.get("protocolVersion").and_then(Value::as_u64),
        Some(PROTOCOL_VERSION as u64)
    );

    let input = vec![0, 1, 2, 3, 254, 255];
    write_frame(
        &mut stdin,
        &Envelope::request_with_binary(
            2,
            "command.run",
            json!({
                "workspace": "/tmp",
                "program": "/bin/cat",
                "args": [],
                "timeoutMs": 5_000,
            }),
            vec![input.clone()],
        ),
    )
    .await
    .unwrap();
    let response = read_frame(&mut stdout).await.unwrap().unwrap();
    let Envelope::Response {
        id,
        result: Some(result),
        binary,
        error: None,
    } = response
    else {
        panic!("unexpected command response: {response:?}");
    };
    assert_eq!(id, 2);
    assert_eq!(result.get("code").and_then(Value::as_i64), Some(0));
    assert_eq!(binary, vec![input, Vec::new()]);

    drop(stdin);
    let status = child.wait().await.unwrap();
    assert!(status.success());
}
