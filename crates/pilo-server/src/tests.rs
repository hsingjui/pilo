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
        SESSION_INDEX_HEADER_BYTES, SESSION_INDEX_PREFIX_STAGES, SESSION_INDEX_TAIL_BYTES,
        SessionIndexSummary, collect_session_change_paths, is_session_change, scan_index,
        summarize_index_bytes,
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

#[cfg(test)]
fn scan_prefix_stages_for_test(
    prefix_stages: &[&[u8]],
    tail: &[u8],
) -> (Option<String>, Option<String>) {
    let mut summary = SessionIndexSummary::default();
    for stage in prefix_stages {
        summarize_index_bytes(stage, false, &mut summary);
    }
    summarize_index_bytes(tail, true, &mut summary);
    (summary.name, summary.first_user_message_preview)
}

#[test]
fn session_index_summary_reads_preview_from_prefix_and_latest_name_from_tail() {
    let prefix = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}\n{\"type\":\"session_info\",\"name\":\"Initial\"}\n";
    let tail =
        "partial line that must be ignored\n{\"type\":\"session_info\",\"name\":\"Renamed\"}\n";
    let (name, preview) = scan_prefix_stages_for_test(&[prefix.as_bytes()], tail.as_bytes());
    assert_eq!(name.as_deref(), Some("Renamed"));
    assert_eq!(preview.as_deref(), Some("hello world"));
}

#[test]
fn session_index_summary_across_split_prefix_stages() {
    // 渐进式扫描按阶段切分前缀：跨越阶段边界的行首段不解析，
    // 后续阶段只解析新增的完整行。
    let first_stage = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}\n{\"type\":\"session_info\",\"name\":\"Initial\"}\n";
    let second_stage = "{\"type\":\"session_info\",\"name\":\"Renamed\"}\n";
    let (name, preview) =
        scan_prefix_stages_for_test(&[first_stage.as_bytes(), second_stage.as_bytes()], b"");
    assert_eq!(name.as_deref(), Some("Renamed"));
    assert_eq!(preview.as_deref(), Some("hello world"));
}

#[test]
fn session_index_summary_skips_user_messages_without_readable_text() {
    // 第一条 user 消息是纯图片（或空文本）时，预览应继续向后寻找后续
    // user 消息，而不是停留在 None。
    let prefix = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"aGk=\",\"mimeType\":\"image/png\"}]}}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"来自第二条消息\"}]}}\n";
    let (name, preview) = scan_prefix_stages_for_test(&[prefix.as_bytes()], b"");
    assert_eq!(name, None);
    assert_eq!(preview.as_deref(), Some("来自第二条消息"));
}

#[test]
fn session_index_summary_finds_name_beyond_large_system_prompt() {
    // 超大 system 消息会把紧跟的 user 消息和 session_info 推出旧前缀窗口；
    // 模拟前缀窗口里有一条超长 system 行、session_info 位于其后。
    let system_text = "x".repeat(200_000);
    let prefix = format!(
        "{{\"type\":\"message\",\"message\":{{\"role\":\"system\",\"content\":\"{system_text}\"}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"修复会话标题\"}}]}}}}\n{{\"type\":\"session_info\",\"name\":\"修复会话标题\"}}\n"
    );
    let (name, preview) = scan_prefix_stages_for_test(&[prefix.as_bytes()], b"");
    assert_eq!(name.as_deref(), Some("修复会话标题"));
    assert_eq!(preview.as_deref(), Some("修复会话标题"));
}

#[test]
fn session_index_reads_latest_name_from_tail_even_when_prefix_is_complete() {
    // 前缀 16KB 内就凑齐了标题和预览，但会话在文件末尾被改过名。
    // 生产扫描必须仍然读尾窗，否则会显示更早的旧标题（旧实现会跳过尾窗）。
    let mut body = String::from(
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}\n{\"type\":\"session_info\",\"name\":\"Initial\"}\n",
    );
    // 填充到超过尾窗大小，保证末尾的改名只落在尾窗、且不与首个前缀阶段重叠。
    while body.len() < SESSION_INDEX_TAIL_BYTES + 4 * 1024 {
        body.push_str(
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"filler\"}}\n",
        );
    }
    body.push_str("{\"type\":\"session_info\",\"name\":\"Renamed\"}\n");

    let size = body.len() as u64;
    assert!(size > SESSION_INDEX_TAIL_BYTES as u64);
    let mut reader = std::io::Cursor::new(body.into_bytes());
    let summary = scan_index(&mut reader, size)
        .expect("scan should succeed")
        .expect("scan should return a summary");
    assert_eq!(summary.name.as_deref(), Some("Renamed"));
    assert_eq!(
        summary.first_user_message_preview.as_deref(),
        Some("hello world")
    );
}

#[test]
fn session_index_io_is_bounded_per_changed_file() {
    assert_eq!(SESSION_INDEX_HEADER_BYTES, 16 * 1024);
    assert_eq!(
        SESSION_INDEX_PREFIX_STAGES,
        [16 * 1024, 64 * 1024, 256 * 1024]
    );
    assert_eq!(SESSION_INDEX_TAIL_BYTES, 32 * 1024);
    const {
        assert!(
            SESSION_INDEX_HEADER_BYTES + SESSION_INDEX_PREFIX_STAGES[2] + SESSION_INDEX_TAIL_BYTES
                <= 320 * 1024
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
