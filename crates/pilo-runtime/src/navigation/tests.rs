use std::sync::Arc;

use pilo_domain::{Project, ProjectMetadata, SessionIndexEntry};

use super::*;
use crate::{host_api::ErrorCode, host_paths::HostPaths, storage};

fn runtime(name: &str) -> (Runtime, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "pilo-runtime-navigation-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
    (runtime, root)
}

fn add_project(runtime: &Runtime, id: &str, path: &Path) -> Project {
    let db = storage::open(&runtime.paths).unwrap();
    let project = Project {
        id: id.into(),
        name: id.into(),
        path: path.to_string_lossy().into_owned(),
        connection: storage::ensure_local_connection(&db).unwrap(),
        metadata: ProjectMetadata {
            cwd: path.to_string_lossy().into_owned(),
            git_branch: None,
            pi_version: String::new(),
            refreshed_at_ms: 0,
        },
        created_at_ms: 0,
        last_opened_at_ms: 0,
    };
    storage::upsert_project(&db, &project).unwrap();
    project
}

fn add_session(runtime: &Runtime, project: &str, id: &str) {
    let db = storage::open(&runtime.paths).unwrap();
    storage::upsert_session(&db, &entry(project, id)).unwrap();
}

fn entry(project: &str, id: &str) -> SessionIndexEntry {
    SessionIndexEntry {
        connection_id: "local".into(),
        project_id: project.into(),
        pi_session_id: id.into(),
        session_path: format!("/sessions/{id}.jsonl"),
        name: None,
        cwd: "/project".into(),
        created_at: String::new(),
        updated_at: String::new(),
        message_count: 0,
        last_message_at: None,
        first_user_message_preview: None,
        file_size: 0,
        file_mtime_ns: 0,
        last_offset: 0,
        indexed_at_ms: 0,
        pinned: false,
        title_override: None,
        archived_at: None,
    }
}

/// Answers every navigation like the desktop UI and records what it was asked.
fn serve_ui(
    navigator: Arc<Navigator>,
    error: Option<&'static str>,
) -> tokio::task::JoinHandle<Vec<NavigationRequest>> {
    tokio::spawn(async move {
        let mut seen = Vec::new();
        while let Some(request) = navigator.next().await {
            navigator.complete(request.id, error.map(str::to_owned));
            seen.push(request);
        }
        seen
    })
}

#[tokio::test]
async fn opening_a_registered_directory_navigates_to_its_project() {
    let (runtime, root) = runtime("directory");
    let directory = root.join("my project");
    std::fs::create_dir_all(&directory).unwrap();
    let directory = std::fs::canonicalize(&directory).unwrap();
    add_project(&runtime, "existing", &directory);
    let ui = serve_ui(runtime.navigator(), None);

    let raw = directory.join("..").join("my project");
    let opened = open(&runtime, Some(raw.to_string_lossy().into_owned()), None)
        .await
        .unwrap();
    assert_eq!(opened["projectId"], "existing");
    assert_eq!(opened["added"], false);

    runtime.navigator().close();
    let seen = ui.await.unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].project_id, "existing");
    assert_eq!(seen[0].session_path, None);
}

#[tokio::test]
async fn opening_rejects_relative_and_missing_directories_and_mixed_targets() {
    let (runtime, root) = runtime("invalid");
    let code = |result: Result<Value, HostApiError>| result.unwrap_err().code;
    assert_eq!(
        code(open(&runtime, Some("relative".into()), None).await),
        ErrorCode::InvalidParams
    );
    let missing = root.join("missing").to_string_lossy().into_owned();
    assert_eq!(
        code(open(&runtime, Some(missing), None).await),
        ErrorCode::InvalidParams
    );
    assert_eq!(
        code(open(&runtime, Some("/".into()), Some("id".into())).await),
        ErrorCode::InvalidParams
    );
    assert_eq!(
        code(open(&runtime, None, None).await),
        ErrorCode::InvalidParams
    );
}

#[tokio::test]
async fn opening_a_session_accepts_full_ids_and_unique_prefixes_only() {
    let (runtime, root) = runtime("sessions");
    std::fs::create_dir_all(&root).unwrap();
    add_project(&runtime, "alpha", &root);
    add_session(&runtime, "alpha", "0198-aaaa-1111");
    add_session(&runtime, "alpha", "0198-aaaa-2222");
    add_session(&runtime, "alpha", "0198-bbbb");
    add_session(&runtime, "alpha", "0198-bbbb-3333");
    let ui = serve_ui(runtime.navigator(), None);

    let opened = open(&runtime, None, Some("0198-aaaa-2".into()))
        .await
        .unwrap();
    assert_eq!(opened["sessionId"], "0198-aaaa-2222");
    assert_eq!(opened["sessionPath"], "/sessions/0198-aaaa-2222.jsonl");
    // A full ID wins over longer IDs that start with it.
    let opened = open(&runtime, None, Some("0198-bbbb".into()))
        .await
        .unwrap();
    assert_eq!(opened["sessionId"], "0198-bbbb");

    let ambiguous = open(&runtime, None, Some("0198-aaaa".into()))
        .await
        .unwrap_err();
    assert_eq!(ambiguous.code, ErrorCode::Conflict);
    assert!(ambiguous.message.contains("0198-aaaa-1111"));
    assert!(ambiguous.message.contains("0198-aaaa-2222"));
    let missing = open(&runtime, None, Some("ffff".into())).await.unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    let path = open(&runtime, None, Some("/sessions/0198-bbbb.jsonl".into()))
        .await
        .unwrap_err();
    assert_eq!(path.code, ErrorCode::InvalidParams);

    runtime.navigator().close();
    let seen = ui.await.unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[1].session_path.as_deref(),
        Some("/sessions/0198-bbbb.jsonl")
    );
}

#[tokio::test]
async fn a_failed_navigation_receipt_is_reported() {
    let (runtime, root) = runtime("receipt");
    std::fs::create_dir_all(&root).unwrap();
    add_project(&runtime, "alpha", &root);
    let ui = serve_ui(runtime.navigator(), Some("project is gone"));
    let error = open(&runtime, Some(root.to_string_lossy().into_owned()), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.message.contains("project is gone"));
    runtime.navigator().close();
    ui.await.unwrap();
}

#[tokio::test]
async fn navigation_waits_for_the_ui_and_gives_up_without_it() {
    let navigator = quick();
    let error = navigator.navigate("alpha".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unavailable);
}

#[tokio::test]
async fn requests_whose_caller_gave_up_are_not_delivered() {
    let navigator = Arc::new(quick());
    navigator.ready.send_replace(true);
    let error = navigator.navigate("stale".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    let ui = serve_ui(navigator.clone(), None);
    navigator.navigate("fresh".into(), None).await.unwrap();
    navigator.close();
    let seen = ui.await.unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].project_id, "fresh");
}

fn quick() -> Navigator {
    Navigator {
        ui_ready_timeout: std::time::Duration::from_millis(50),
        receipt_timeout: std::time::Duration::from_millis(50),
        ..Navigator::default()
    }
}
