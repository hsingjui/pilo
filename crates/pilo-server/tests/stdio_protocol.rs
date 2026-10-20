use std::{
    path::PathBuf,
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};

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

    write_frame(&mut stdin, Envelope::request(1, "server.ping", Value::Null))
        .await
        .unwrap();
    let ping = read_frame(&mut stdout).await.unwrap().unwrap();
    let Envelope::Response {
        id,
        result: Some(result),
        binary,
        error: None,
    } = ping
    else {
        panic!("unexpected ping response: {ping:?}");
    };
    assert_eq!(id, 1);
    assert!(binary.is_empty());
    assert_eq!(
        result.get("protocolVersion").and_then(Value::as_u64),
        Some(PROTOCOL_VERSION as u64)
    );

    let (program, args) = if cfg!(windows) {
        (
            "powershell.exe",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                // Avoid PowerShell's text pipeline so every byte is preserved.
                "[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())",
            ],
        )
    } else {
        ("/bin/cat", vec![])
    };
    let input = vec![0, 1, 2, 3, 254, 255];
    write_frame(
        &mut stdin,
        Envelope::request_with_binary(
            2,
            "command.run",
            json!({
                "project": std::env::temp_dir(),
                "program": program,
                "args": args,
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

#[cfg(unix)]
#[tokio::test]
async fn closing_server_stdin_reaps_running_pi_process() {
    use std::os::unix::fs::PermissionsExt;
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/shutdown-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let fake_pi = dir.join(format!("pi-{unique}.sh"));
    std::fs::write(
        &fake_pi,
        "#!/bin/sh\nprintf '{\"type\":\"test_pid\",\"pid\":%s}\\n' \"$$\"\nexec cat\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake_pi, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut server = Command::new(env!("CARGO_BIN_EXE_pilo-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = server.stdin.take().unwrap();
    let mut stdout = server.stdout.take().unwrap();
    write_frame(
        &mut stdin,
        Envelope::request(
            1,
            "pi.start",
            json!({
                "streamId": "shutdown-pi", "project": dir, "piExecutable": fake_pi,
            }),
        ),
    )
    .await
    .unwrap();
    let pid = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let mut started = false;
        let mut pid = None;
        while !started || pid.is_none() {
            match read_frame(&mut stdout).await.unwrap().unwrap() {
                Envelope::Response {
                    id: 1, error: None, ..
                } => started = true,
                Envelope::Response {
                    error: Some(error), ..
                } => panic!("pi.start failed: {error:?}"),
                Envelope::Event { event, binary, .. } if event == "pi.rpc_json" => {
                    let message: Value = serde_json::from_slice(&binary[0]).unwrap();
                    pid = message.get("pid").and_then(Value::as_u64);
                }
                _ => {}
            }
        }
        pid.unwrap()
    })
    .await
    .unwrap();
    drop(stdin);
    // Keep draining stdout while EOF cleanup finishes, just like ServerClient.
    let drain =
        tokio::spawn(async move { while read_frame(&mut stdout).await.unwrap().is_some() {} });
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), server.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    drain.await.unwrap();
    let alive = Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(
        !alive.success(),
        "Pi child should be reaped after server EOF"
    );
    std::fs::remove_file(fake_pi).unwrap();
}

#[tokio::test]
async fn session_read_returns_file_fingerprint() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "pilo-server-session-read-test-{}-{unique}",
        std::process::id()
    ));
    let agent_dir: PathBuf = base.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let session_path = sessions_dir.join("history.jsonl");
    let contents = b"{\"type\":\"session\",\"version\":3}\n";
    std::fs::write(&session_path, contents).unwrap();

    let executable = env!("CARGO_BIN_EXE_pilo-server");
    let mut child = Command::new(executable)
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("failed to spawn pilo-server");
    let mut stdin = child.stdin.take().expect("missing server stdin");
    let mut stdout = child.stdout.take().expect("missing server stdout");

    write_frame(
        &mut stdin,
        Envelope::request(
            1,
            "session.read",
            json!({
                "path": session_path.to_string_lossy(),
                "offset": 0,
                "limit": 1,
            }),
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
        panic!("unexpected session.read response: {response:?}");
    };

    assert_eq!(id, 1);
    assert_eq!(
        result.get("fileSize").and_then(Value::as_u64),
        Some(contents.len() as u64)
    );
    assert!(
        result
            .get("fileMtimeNs")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0)
    );
    assert_eq!(result.get("nextOffset").and_then(Value::as_u64), Some(1));
    assert_eq!(result.get("eof").and_then(Value::as_bool), Some(false));
    assert_eq!(binary, vec![contents[..1].to_vec()]);

    drop(stdin);
    let status = child.wait().await.unwrap();
    assert!(status.success());
    std::fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn file_links_use_the_server_filesystem_and_binary_transport() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target")
        .join(format!("file-link-stdio-test-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let report = base.join("报告 page.pdf");
    let document = b"%PDF-1.7\n\0\xff";
    std::fs::write(&report, document).unwrap();
    let source = base.join("source.rs");
    let text = "// 远程代码\nfn main() {}";
    std::fs::write(&source, text).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_pilo-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    write_frame(&mut stdin, Envelope::request(1, "server.ping", Value::Null))
        .await
        .unwrap();
    let ping = read_frame(&mut stdout).await.unwrap().unwrap();
    let Envelope::Response {
        result: Some(ping),
        error: None,
        ..
    } = ping
    else {
        panic!("unexpected ping: {ping:?}");
    };
    assert!(
        ping["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("file_link.read"))
    );

    for (id, path, preview, expected) in [
        (2, &report, false, document.as_slice()),
        (3, &source, true, text.as_bytes()),
    ] {
        write_frame(
            &mut stdin,
            Envelope::request(
                id,
                "file_link.read",
                json!({ "path": path, "preview": preview }),
            ),
        )
        .await
        .unwrap();
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(5), read_frame(&mut stdout))
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        let Envelope::Response {
            id: response_id,
            result: Some(metadata),
            binary,
            error: None,
        } = response
        else {
            panic!("unexpected file link response: {response:?}");
        };
        assert_eq!(response_id, id);
        assert_eq!(
            metadata["path"],
            std::fs::canonicalize(path)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/")
        );
        assert_eq!(binary, vec![expected.to_vec()]);
    }
    write_frame(
        &mut stdin,
        Envelope::request(
            4,
            "file_link.read",
            json!({ "path": "relative.md", "preview": true }),
        ),
    )
    .await
    .unwrap();
    let response = read_frame(&mut stdout).await.unwrap().unwrap();
    assert!(
        matches!(response, Envelope::Response { id: 4, result: None, error: Some(_), ref binary } if binary.is_empty())
    );

    drop(stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    std::fs::remove_dir_all(base).unwrap();
}
