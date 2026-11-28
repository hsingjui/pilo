//! Runs the `pilo` binary against an embedded Host listening on the endpoint
//! the CLI derives itself.
#![cfg(target_os = "macos")]

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use pilo_ipc::{Endpoint, endpoint};
use pilo_runtime::{Runtime, host_paths::HostPaths, local_ipc::LocalIpcConfig};
use serde_json::Value;

const APP_ID: &str = "app.hsingjui.pilo.dev";

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let mut bytes = [0_u8; 4];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
            .unwrap();
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let home = PathBuf::from(format!("/tmp/pilo-cli-{name}"));
        std::fs::create_dir_all(&home).unwrap();
        Self(home)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn pilo(home: &Path, args: &[&str], stdin: &str) -> (i32, Value, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_pilo"))
        .args(args)
        .env("HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output().unwrap();
    let stdout = String::from_utf8(stdout).unwrap();
    let value = if stdout.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&stdout)
            .unwrap_or_else(|_| panic!("stdout is not one JSON value: {stdout}"))
    };
    (
        status.code().unwrap(),
        value,
        String::from_utf8(stderr).unwrap(),
    )
}

fn error_category(stderr: &str) -> String {
    let value: Value = serde_json::from_str(stderr.trim()).unwrap();
    value["error"]["category"].as_str().unwrap().to_owned()
}

async fn host(home: &Path) -> (Runtime, pilo_runtime::local_ipc::LocalIpcServer) {
    let runtime = Runtime::new(HostPaths::new(home.join("data"), home.join("resources")).unwrap());
    let endpoint =
        endpoint::derive_unix(endpoint::UnixPlatform::MacOs, APP_ID, Some(home), None, 0).unwrap();
    let server = runtime
        .start_local_ipc_at(
            Endpoint::Unix(endpoint),
            LocalIpcConfig {
                app_id: APP_ID.to_owned(),
                app_version: "0.0.0-test".to_owned(),
                installation: None,
            },
        )
        .await
        .unwrap();
    (runtime, server)
}

#[test]
fn version_and_help_need_no_host() {
    let home = Home::new();
    let (code, value, _) = pilo(&home.0, &["version"], "");
    assert_eq!(code, 0);
    assert_eq!(value["cli"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        value["appId"],
        option_env!("PILO_CLI_APP_ID").unwrap_or(APP_ID)
    );
    let (_, value, _) = pilo(&home.0, &["--dev", "--version"], "");
    assert_eq!(value["appId"], APP_ID);
    let output = Command::new(env!("CARGO_BIN_EXE_pilo"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .starts_with("pilo - ")
    );
}

#[test]
fn offline_and_usage_errors_are_categorized() {
    let home = Home::new();
    let (code, value, stderr) = pilo(&home.0, &["--dev", "projects", "list"], "");
    assert_eq!((code, value), (3, Value::Null));
    assert_eq!(error_category(&stderr), "offline");
    let (code, _, stderr) = pilo(&home.0, &["open"], "");
    assert_eq!(code, 2);
    assert_eq!(error_category(&stderr), "invalid_input");
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_reach_the_host_as_local() {
    let home = Home::new();
    let (_runtime, server) = host(&home.0).await;
    let path = home.0.clone();
    let run = move |args: &'static [&'static str], stdin: &'static str| {
        let path = path.clone();
        async move {
            tokio::task::spawn_blocking(move || pilo(&path, args, stdin))
                .await
                .unwrap()
        }
    };

    let (code, value, stderr) = run(&["--dev", "projects", "list"], "").await;
    assert_eq!(code, 0, "{stderr}");
    assert!(value.is_array());
    let (code, value, stderr) = run(&["--dev", "settings", "get"], "").await;
    assert_eq!(code, 0, "{stderr}");
    assert!(value.is_object());
    let (code, value, stderr) = run(&["--dev", "settings", "theme", "get"], "").await;
    assert_eq!(code, 0, "{stderr}");
    assert!(value.is_object());

    // Project-scoped session commands reject unknown projects instead of guessing.
    for args in [
        &["--dev", "sessions", "status", "s1", "--project", "missing"][..],
        &["--dev", "sessions", "list", "--project", "missing"],
        &["--dev", "sessions", "stop", "s1", "--project", "missing"],
    ] {
        let args: &'static [&'static str] = Box::leak(args.to_vec().into_boxed_slice());
        let (code, _, stderr) = run(args, "").await;
        assert_eq!(code, 5, "{args:?}: {stderr}");
        assert_eq!(error_category(&stderr), "rejected");
    }
    let (code, _, stderr) = run(
        &["--dev", "sessions", "create", "--project", "missing"],
        r#"{"message":"hello"}"#,
    )
    .await;
    assert_eq!(
        (code, error_category(&stderr).as_str()),
        (5, "rejected"),
        "{stderr}"
    );
    let (code, _, stderr) = run(
        &["--dev", "sessions", "create", "--project", "p"],
        r#"{"text":"x"}"#,
    )
    .await;
    assert_eq!(
        (code, error_category(&stderr).as_str()),
        (2, "invalid_input")
    );
    let (code, _, stderr) = run(&["--dev", "settings", "patch"], r#"{"noSuchPreference":1}"#).await;
    assert_eq!(
        (code, error_category(&stderr).as_str()),
        (2, "invalid_input"),
        "{stderr}"
    );

    server.stop().await;
    let (code, _, _) = run(&["--dev", "projects", "list"], "").await;
    assert_eq!(code, 3);
}

/// A Host stand-in that answers hello, reads one request and then either hangs
/// up or never replies.
async fn fake_host(home: &Path, reply: bool) -> tokio::task::JoinHandle<serde_json::Value> {
    use pilo_ipc::{read_frame, write_frame};
    let endpoint =
        endpoint::derive_unix(endpoint::UnixPlatform::MacOs, APP_ID, Some(home), None, 0).unwrap();
    std::fs::create_dir_all(endpoint.path.parent().unwrap()).unwrap();
    let listener = tokio::net::UnixListener::bind(&endpoint.path).unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_frame(&mut stream).await.unwrap().unwrap();
        let hello = serde_json::json!({
            "protocol": "2.0",
            "hostId": "fake",
            "appVersion": "0.0.0",
            "capabilities": {},
        });
        write_frame(&mut stream, &hello).await.unwrap();
        let request = read_frame(&mut stream).await.unwrap().unwrap();
        if reply {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
        request
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn create_reports_its_session_id_when_the_outcome_is_unknown() {
    for hang in [false, true] {
        let home = Home::new();
        let host = fake_host(&home.0, hang).await;
        let path = home.0.clone();
        let (code, stdout, stderr) = tokio::task::spawn_blocking(move || {
            pilo(
                &path,
                &[
                    "--dev",
                    "--timeout",
                    "0.5",
                    "sessions",
                    "create",
                    "--project",
                    "p",
                ],
                r#"{"message":"hello"}"#,
            )
        })
        .await
        .unwrap();
        assert_eq!((code, stdout), (6, Value::Null), "{stderr}");
        let error: Value = serde_json::from_str(stderr.trim()).unwrap();
        assert_eq!(error["error"]["category"], "outcome_unknown");
        let session_id = error["error"]["sessionId"].as_str().unwrap().to_owned();
        assert!(session_id.starts_with("cli-"), "{error}");
        if !hang {
            let request = host.await.unwrap();
            assert_eq!(request["method"], "session.create");
            assert_eq!(request["params"]["sessionId"], session_id.as_str());
        } else {
            host.abort();
        }
    }
}
