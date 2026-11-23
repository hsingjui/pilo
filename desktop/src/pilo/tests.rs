use super::*;
use pilo_domain::{Project, ProjectMetadata};
use pilo_runtime::storage;

#[test]
fn bootstrap_reads_existing_projects_and_shutdown_closes_the_handle() {
    let data = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(data.path().into(), data.path().into()).unwrap();
    let db = storage::open(&paths).unwrap();
    let project = Project {
        id: "saved-project".into(),
        name: "Saved project".into(),
        path: "/projects/saved".into(),
        connection: storage::ensure_local_connection(&db).unwrap(),
        metadata: ProjectMetadata {
            cwd: "/projects/saved".into(),
            git_branch: Some("main".into()),
            pi_version: "test".into(),
            refreshed_at_ms: 2,
        },
        created_at_ms: 1,
        last_opened_at_ms: 3,
    };
    storage::upsert_project(&db, &project).unwrap();
    drop(db);

    let pilo = Pilo::new(Some(data.path().to_str().unwrap().into()), None).unwrap();
    pilo.executor.block_on(async {
        let initial = Pilo::load_bootstrap(pilo.host.clone()).await.unwrap();
        let saved = initial
            .projects
            .iter()
            .find(|item| item["id"] == project.id)
            .unwrap();
        assert_eq!(saved, &serde_json::to_value(project).unwrap());
        assert!(initial.chat_sessions.is_empty());

        let host = pilo.host.clone();
        let ((), ()) = tokio::join!(stop_host(host.clone()), stop_host(host.clone()));
        assert!(matches!(Pilo::load_bootstrap(host).await, Err(error) if error == CLOSED));
    });
}

#[test]
fn bootstrap_surfaces_database_errors() {
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("pilo.sqlite3");
    std::fs::create_dir(&database).unwrap();
    let pilo = Pilo::new(Some(data.path().to_str().unwrap().into()), None).unwrap();
    pilo.executor.block_on(async {
        let result = Pilo::load_bootstrap(pilo.host.clone()).await;
        assert!(matches!(result, Err(error) if error.contains("failed to open Pilo SQLite index")));
        std::fs::remove_dir(database).unwrap();
        assert!(Pilo::load_bootstrap(pilo.host.clone()).await.is_ok());
        stop_host(pilo.host.clone()).await;
    });
}

#[test]
fn runtime_operation_does_not_block_shutdown() {
    let data = tempfile::tempdir().unwrap();
    let pilo = Pilo::new(Some(data.path().to_str().unwrap().into()), None).unwrap();
    pilo.executor.block_on(async {
        let (admitted, ready) = tokio::sync::oneshot::channel();
        let (finish, pending) = tokio::sync::oneshot::channel();
        let operation = tokio::spawn(run_with_runtime(pilo.host.clone(), |_| async move {
            admitted.send(()).unwrap();
            pending.await.unwrap();
            Ok(())
        }));
        ready.await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stop_host(pilo.host.clone()),
        )
        .await
        .expect("shutdown waited for an admitted operation");
        assert_eq!(
            run_with_runtime(pilo.host.clone(), |_| async { Ok(()) }).await,
            Err(CLOSED.to_owned()),
        );
        finish.send(()).unwrap();
        operation.await.unwrap().unwrap();
    });
}

#[test]
fn event_batch_reports_gap_then_preserves_later_events() {
    let data = tempfile::tempdir().unwrap();
    let pilo = Pilo::new(Some(data.path().to_str().unwrap().into()), None).unwrap();
    pilo.executor.block_on(async {
        let runtime = pilo.host.lock().await.as_ref().unwrap().clone();
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 1,
            max_bytes: EVENT_QUEUE_LIMITS.max_bytes,
        });
        let start = stream.start_sequence();
        for locale in ["zh-CN", "en-US", "zh-CN"] {
            preferences_patch(
                &runtime,
                [("locale".to_owned(), JsonValue::from(locale))]
                    .into_iter()
                    .collect(),
                None,
            )
            .unwrap();
        }
        assert_eq!(
            encode_event_batch(stream.try_next_batch(1).unwrap()).unwrap(),
            serde_json::json!({ "type": "gap", "firstMissed": start + 1, "lastMissed": start + 2 }),
        );
        let batch = encode_event_batch(stream.try_next_batch(1).unwrap()).unwrap();
        assert_eq!(batch["type"], "events");
        assert_eq!(batch["events"][0]["sequence"], start + 3);
        assert_eq!(batch["events"][0]["type"], "preferences_changed");
        assert_eq!(batch["events"][0]["settings"]["values"]["locale"], "zh-CN");
        stop_host(pilo.host.clone()).await;
    });
}

#[test]
fn sanitize_save_file_name_strips_directories_and_control_chars() {
    assert_eq!(shell::sanitize_save_file_name("shot.png"), "shot.png");
    assert_eq!(
        shell::sanitize_save_file_name("../../nested/dir/shot.webp"),
        "shot.webp"
    );
    assert_eq!(shell::sanitize_save_file_name(r"C:\tmp\pic.jpg"), "pic.jpg");
    assert_eq!(shell::sanitize_save_file_name(""), "image");
    assert_eq!(shell::sanitize_save_file_name(".."), "image");
    assert_eq!(shell::sanitize_save_file_name("bad\nname.png"), "image");
}

#[test]
fn git_commands_reject_unknown_project() {
    let data = tempfile::tempdir().unwrap();
    let pilo = Pilo::new(Some(data.path().to_str().unwrap().into()), None).unwrap();
    pilo.executor.block_on(async {
        let runtime = pilo.host.lock().await.as_ref().unwrap().clone();
        assert!(
            project_api::project_git_status(&runtime, "missing-project".into())
                .await
                .is_err()
        );
        assert!(
            project_api::project_git_diff(
                &runtime,
                "missing-project".into(),
                Some("src/lib.rs".into()),
                false
            )
            .await
            .is_err()
        );
        stop_host(pilo.host.clone()).await;
    });
}
