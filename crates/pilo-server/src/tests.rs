use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::UNIX_EPOCH,
};

use notify::{Event, EventKind};
use serde_json::json;
use tokio::io::AsyncWriteExt;

use super::*;
use crate::{
    command::read_bounded_output,
    fs_ops::{FsSearchParams, checked_existing_path, checked_mutation_path, fs_search},
    session::{
        SESSION_INDEX_HEADER_BYTES, SESSION_INDEX_PREFIX_BYTES, SESSION_INDEX_TAIL_BYTES,
        collect_session_change_paths, is_session_change, summarize_session_index,
    },
};

#[tokio::test]
async fn bounded_output_discards_bytes_after_shared_limit() {
    let (mut writer, reader) = tokio::io::duplex(64);
    let write_task = tokio::spawn(async move {
        writer.write_all(b"0123456789").await.unwrap();
    });
    let used = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let output = read_bounded_output(reader, Arc::clone(&used), Arc::clone(&overflowed), 4)
        .await
        .unwrap();
    write_task.await.unwrap();

    assert_eq!(output, b"0123");
    assert_eq!(used.load(Ordering::Acquire), 10);
    assert!(overflowed.load(Ordering::Acquire));
}

#[test]
fn session_index_summary_reads_preview_from_prefix_and_latest_name_from_tail() {
    let prefix = concat!(
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}\n",
        "{\"type\":\"session_info\",\"name\":\"Initial\"}\n"
    );
    let tail = concat!(
        "partial line that must be ignored\n",
        "{\"type\":\"session_info\",\"name\":\"Renamed\"}\n"
    );
    let (name, preview) = summarize_session_index(prefix.as_bytes(), tail.as_bytes());
    assert_eq!(name.as_deref(), Some("Renamed"));
    assert_eq!(preview.as_deref(), Some("hello world"));
}

#[test]
fn session_index_io_is_bounded_per_changed_file() {
    assert_eq!(SESSION_INDEX_HEADER_BYTES, 16 * 1024);
    assert_eq!(SESSION_INDEX_PREFIX_BYTES, 32 * 1024);
    assert_eq!(SESSION_INDEX_TAIL_BYTES, 32 * 1024);
    const {
        assert!(
            SESSION_INDEX_HEADER_BYTES + SESSION_INDEX_PREFIX_BYTES + SESSION_INDEX_TAIL_BYTES
                <= 80 * 1024
        );
    }
}

#[test]
fn session_watcher_filters_to_jsonl_changes_in_target() {
    let target = PathBuf::from("sessions/project");
    let changed = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
        .add_path(target.join("session.jsonl"));
    let unrelated = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
        .add_path(PathBuf::from("sessions/other/session.jsonl"));
    let non_session = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
        .add_path(target.join("notes.txt"));
    let access = Event::new(EventKind::Access(notify::event::AccessKind::Any))
        .add_path(target.join("session.jsonl"));

    assert!(is_session_change(&changed, &target));
    assert!(!is_session_change(&unrelated, &target));
    assert!(!is_session_change(&non_session, &target));
    assert!(!is_session_change(&access, &target));
}

#[test]
fn session_watcher_collects_touched_paths_and_directory_fallback() {
    let target = PathBuf::from("sessions/project");
    let first = target.join("first.jsonl");
    let second = target.join("second.jsonl");
    let changed = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
        .add_path(first.clone())
        .add_path(second.clone());
    let mut touched = std::collections::HashSet::new();
    let mut full_refresh = false;

    assert!(collect_session_change_paths(
        &changed,
        &target,
        &mut touched,
        &mut full_refresh,
    ));
    assert_eq!(touched.len(), 2);
    assert!(touched.contains(&first));
    assert!(touched.contains(&second));
    assert!(!full_refresh);

    let directory =
        Event::new(EventKind::Create(notify::event::CreateKind::Folder)).add_path(target.clone());
    assert!(collect_session_change_paths(
        &directory,
        &target,
        &mut touched,
        &mut full_refresh,
    ));
    assert!(full_refresh);
}

#[cfg(unix)]
#[test]
fn remote_fs_does_not_follow_symlinks_outside_project() {
    use std::os::unix::fs::symlink;

    let unique = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "pilo-server-fs-test-{}-{unique}",
        std::process::id()
    ));
    let project = base.join("project");
    let outside = base.join("outside");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
    symlink(&outside, project.join("escape")).unwrap();

    let project_text = project.to_string_lossy();
    assert!(checked_existing_path(&project_text, "escape/secret.txt", false).is_err());
    assert!(checked_mutation_path(&project_text, "escape/new.txt").is_err());

    let search = fs_search(FsSearchParams {
        project: project_text.into_owned(),
        query: "secret".to_owned(),
    })
    .unwrap();
    assert_eq!(search, json!([]));

    std::fs::remove_dir_all(base).unwrap();
}
