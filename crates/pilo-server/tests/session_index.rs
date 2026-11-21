use std::{
    fs,
    path::PathBuf,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pilo_protocol::{Envelope, SessionFile, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Fixture {
    base: PathBuf,
    sessions: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/session-scan-tests")
            .join(format!("{}-{unique}", std::process::id()));
        let sessions = base.join("agent/sessions/--title-regression--");
        fs::create_dir_all(&sessions).unwrap();
        Self { base, sessions }
    }

    fn write(&self, name: &str, title: Option<&str>) -> Value {
        let path = self.sessions.join(format!("{name}.jsonl"));
        let mut body =
            b"{\"type\":\"session\",\"id\":\"session-id\",\"cwd\":\"/title-regression\"}\n"
                .to_vec();
        if let Some(title) = title {
            body.resize(280 * 1024 - 1, b'x');
            body.push(b'\n');
            body.extend(format!("{}\n", json!({"type": "session_info", "name": title})).bytes());
            body.resize(400 * 1024 - 1, b'x');
            body.push(b'\n');
        }
        fs::write(&path, body).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        json!({
            "path": path,
            "size": metadata.len(),
            "mtimeNs": metadata.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64,
            "recoverName": true,
        })
    }

    fn start(&self) -> Server {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pilo-server"))
            .env("PI_CODING_AGENT_DIR", self.base.join("agent"))
            .env("PILO_SERVER_RUNTIME_DIR", self.base.join("runtime"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Server {
            child,
            stdin,
            stdout,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl Server {
    async fn scan(
        &mut self,
        known: Vec<Value>,
        paths: Vec<Value>,
        limit: usize,
    ) -> Vec<SessionFile> {
        write_frame(&mut self.stdin, Envelope::request(1, "session.scan", json!({
            "project": "/title-regression", "known": known, "paths": paths, "summaryLimit": limit,
        }))).await.unwrap();
        let response = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut self.stdout))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match response {
            Envelope::Response {
                id: 1,
                result: Some(result),
                error: None,
                ..
            } => serde_json::from_value(result).unwrap(),
            other => panic!("unexpected session.scan response: {other:?}"),
        }
    }

    async fn scan_one(&mut self, known: &Value) -> SessionFile {
        let mut files = self
            .scan(vec![known.clone()], vec![known["path"].clone()], 1)
            .await;
        assert_eq!(files.len(), 1);
        files.remove(0)
    }

    async fn finish(self) {
        let Self {
            mut child,
            stdin,
            mut stdout,
        } = self;
        drop(stdin);
        let drain =
            tokio::spawn(async move { while read_frame(&mut stdout).await.unwrap().is_some() {} });
        assert!(
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        drain.await.unwrap();
    }
}

#[tokio::test]
async fn unchanged_titles_recover_retry_until_host_stores_and_rescan_after_restart() {
    let fixture = Fixture::new();
    let named = fixture.write("named", Some("隐藏的标题"));
    let untitled = fixture.write("untitled", None);
    let blank = fixture.write("blank", Some("  "));
    let original = fs::read(named["path"].as_str().unwrap()).unwrap();
    let mut server = fixture.start();

    // Legacy callers retain fingerprint-only behavior, even before Server has scan progress.
    let mut legacy = named.clone();
    legacy.as_object_mut().unwrap().remove("recoverName");
    assert!(server.scan_one(&legacy).await.unchanged);
    let deferred = server
        .scan(vec![named.clone()], vec![named["path"].clone()], 0)
        .await;
    assert!(deferred[0].deferred);
    for _ in 0..2 {
        let recovered = server.scan_one(&named).await;
        assert!(!recovered.unchanged);
        assert!(!recovered.deferred);
        assert_eq!(recovered.name.as_deref(), Some("隐藏的标题"));
    }
    let mut stored = named.clone();
    stored["recoverName"] = json!(false);
    assert!(server.scan_one(&stored).await.unchanged);

    for known in [&untitled, &blank] {
        let scanned = server.scan_one(known).await;
        assert!(!scanned.unchanged);
        // The Host stores this to stop asking after a restart.
        assert!(scanned.name_scanned);
        assert!(
            scanned
                .name
                .as_deref()
                .is_none_or(|name| name.trim().is_empty())
        );
        assert!(server.scan_one(known).await.unchanged);
        let reused = server
            .scan(vec![known.clone()], vec![known["path"].clone()], 0)
            .await;
        assert!(reused[0].unchanged);
        assert!(!reused[0].deferred);
    }
    server.finish().await;

    let mut server = fixture.start();
    assert!(!server.scan_one(&untitled).await.unchanged);
    assert!(server.scan_one(&untitled).await.unchanged);
    assert_eq!(
        server.scan_one(&named).await.name.as_deref(),
        Some("隐藏的标题")
    );
    server.finish().await;
    assert_eq!(fs::read(named["path"].as_str().unwrap()).unwrap(), original);
}

#[tokio::test]
async fn title_scan_cache_evicts_least_recently_used_snapshot() {
    let fixture = Fixture::new();
    let known = (0..257)
        .map(|index| fixture.write(&format!("session-{index:03}"), None))
        .collect::<Vec<_>>();
    let mut server = fixture.start();
    // Populate in a deterministic order; directory scans summarize files concurrently.
    for entry in &known[..256] {
        assert!(!server.scan_one(entry).await.unchanged);
    }
    assert!(server.scan_one(&known[0]).await.unchanged); // Refresh the oldest entry.
    assert!(!server.scan_one(&known[256]).await.unchanged);
    assert!(server.scan_one(&known[0]).await.unchanged);
    assert!(server.scan_one(&known[2]).await.unchanged);
    assert!(!server.scan_one(&known[1]).await.unchanged); // Entry 1 was least recently used.
    assert!(server.scan_one(&known[1]).await.unchanged);
    server.finish().await;
}
