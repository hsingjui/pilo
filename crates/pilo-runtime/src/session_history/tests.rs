use std::sync::Arc;

use super::{
    cache::{
        HistoryStorage, SESSION_HISTORY_CACHE_CAPACITY, SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES,
        SessionFileFingerprint, SessionHistoryCache, SessionHistoryWindowIndex,
        fingerprint_from_metadata,
    },
    disk::DiskHistory,
    incremental::{MAX_INCREMENTAL_UPDATES, extend_projection},
    parser::{HistoryParser, parse_history},
    serialize::serialize_windowed_history,
    types::{ConversationEventDto, TurnCompletion},
};

#[test]
fn history_cache_reuses_matching_fingerprint_without_dropping_valid_entry() {
    let mut cache = SessionHistoryCache::default();
    let first_fingerprint = SessionFileFingerprint {
        file_size: 100,
        file_mtime_ns: 200,
    };
    let changed_fingerprint = SessionFileFingerprint {
        file_size: 101,
        file_mtime_ns: 201,
    };
    let serialized = Arc::new(vec![1, 2, 3]);

    cache.insert_serialized(
        "project\0session".to_owned(),
        first_fingerprint,
        Arc::clone(&serialized),
    );
    assert!(Arc::ptr_eq(
        &cache
            .get_serialized("project\0session", first_fingerprint)
            .unwrap(),
        &serialized
    ));
    assert_eq!(
        cache.get_serialized("project\0session", changed_fingerprint),
        None
    );
    assert!(cache.entries.contains_key("project\0session"));
    assert!(Arc::ptr_eq(
        &cache
            .get_serialized("project\0session", first_fingerprint)
            .unwrap(),
        &serialized
    ));
}

#[test]
fn history_cache_evicts_least_recently_used_entries() {
    let mut cache = SessionHistoryCache::default();
    let fingerprint = SessionFileFingerprint {
        file_size: 1,
        file_mtime_ns: 1,
    };
    for index in 0..SESSION_HISTORY_CACHE_CAPACITY {
        cache.insert_serialized(
            format!("session-{index}"),
            fingerprint,
            Arc::new(vec![index as u8]),
        );
    }

    assert!(cache.get_serialized("session-0", fingerprint).is_some());
    cache.insert_serialized("session-new".to_owned(), fingerprint, Arc::new(vec![255]));

    assert!(cache.entries.contains_key("session-0"));
    assert!(!cache.entries.contains_key("session-1"));
    assert!(cache.entries.contains_key("session-new"));
}

#[test]
fn history_cache_respects_estimated_byte_budget() {
    let mut cache = SessionHistoryCache::default();
    let file_size = (SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES / 4) as u64;
    for index in 0..3 {
        cache.insert_serialized(
            format!("large-{index}"),
            SessionFileFingerprint {
                file_size,
                file_mtime_ns: index,
            },
            Arc::new(vec![index as u8]),
        );
    }

    assert!(!cache.entries.contains_key("large-0"));
    assert!(cache.entries.contains_key("large-1"));
    assert!(cache.entries.contains_key("large-2"));
}

#[test]
fn history_cache_skips_single_entry_larger_than_byte_budget() {
    let mut cache = SessionHistoryCache::default();
    cache.insert_serialized(
        "too-large".to_owned(),
        SessionFileFingerprint {
            file_size: SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES as u64,
            file_mtime_ns: 1,
        },
        Arc::new(vec![1]),
    );

    assert!(!cache.entries.contains_key("too-large"));
}

#[test]
fn session_read_fingerprint_is_optional_for_older_servers() {
    assert_eq!(
        fingerprint_from_metadata(&serde_json::json!({
            "fileSize": 123,
            "fileMtimeNs": 456,
        })),
        Some(SessionFileFingerprint {
            file_size: 123,
            file_mtime_ns: 456,
        })
    );
    assert_eq!(
        fingerprint_from_metadata(&serde_json::json!({
            "nextOffset": 1,
            "eof": false,
        })),
        None
    );
}

#[test]
fn incremental_history_parser_matches_whole_file_across_chunk_boundaries() {
    let bytes = concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"你好 world\"}}\n",
        "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}}\n"
    ).as_bytes();
    let expected = parse_history(bytes);

    for chunk_size in [1, 2, 7, 31, 128] {
        let mut parser = HistoryParser::default();
        for chunk in bytes.chunks(chunk_size) {
            parser.push(chunk);
        }
        assert_eq!(parser.finish(), expected, "chunk size {chunk_size}");
    }
}

#[test]
fn selects_only_the_active_session_branch() {
    let bytes = concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
        "{\"type\":\"message\",\"id\":\"a-old\",\"parentId\":\"u1\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"old\"}],\"stopReason\":\"stop\"}}\n",
        "{\"type\":\"message\",\"id\":\"a-new\",\"parentId\":\"u1\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"new\"}],\"stopReason\":\"stop\"}}\n"
    ).as_bytes();
    let history = parse_history(bytes);
    let serialized = serde_json::to_string(&history.events).unwrap();
    assert!(serialized.contains("new"));
    assert!(!serialized.contains("old"));
    assert_eq!(history.source_message_count, 2);
}

#[test]
fn system_messages_are_kept_out_of_conversation_events_and_visible_stats() {
    let bytes = concat!(
        "{\"type\":\"message\",\"id\":\"s1\",\"parentId\":null,\"message\":{\"role\":\"system\",\"content\":\"\",\"sections\":{\"cwd\":\"/root/code/project\",\"project_context\":\"secret context\"}}}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":\"s1\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
        "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}}\n"
    )
    .as_bytes();

    let history = parse_history(bytes);
    let serialized = serde_json::to_string(&history.events).unwrap();

    assert_eq!(history.source_message_count, 3);
    assert_eq!(history.stats.total_messages, 2);
    assert_eq!(history.stats.user_messages, 1);
    assert_eq!(history.stats.assistant_messages, 1);
    assert!(!serialized.contains("Unrecognized Session message"));
    assert!(!serialized.contains("secret context"));
    assert!(serialized.contains("hello"));
    assert!(serialized.contains("done"));
}

#[test]
fn user_image_content_is_summarized_without_inlining_base64() {
    let bytes = concat!(
        "{\"type\":\"message\",\"id\":\"u1\",\"message\":{\"role\":\"user\",\"content\":[",
        "{\"type\":\"text\",\"text\":\"看这张图\"},",
        "{\"type\":\"image\",\"data\":\"VERY_LARGE_BASE64_PAYLOAD\",\"mimeType\":\"image/png\"}]}}\n"
    )
    .as_bytes();
    let history = parse_history(bytes);
    let serialized = serde_json::to_string(&history.events).unwrap();
    assert!(serialized.contains("看这张图"));
    assert!(!serialized.contains("[图片]"));
    assert!(!serialized.contains("VERY_LARGE_BASE64_PAYLOAD"));
    assert!(serialized.contains("\"id\":\"u1:1\""));
    assert!(serialized.contains("\"mimeType\":\"image/png\""));
}

#[test]
fn image_locations_record_line_byte_ranges() {
    let first = r#"{"type":"message","id":"u1","message":{"role":"user","content":"hi"}}"#;
    let second = r#"{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"image","data":"aGk=","mimeType":"image/png"}]}}"#;
    let bytes = format!("{first}\n{second}\n").into_bytes();
    let history = parse_history(&bytes);
    let location = history.image_locations.get("u2:0").copied().unwrap();
    // The range covers the JSON line itself, without its trailing newline.
    assert_eq!(location.byte_offset, (first.len() + 1) as u64);
    assert_eq!(location.byte_length, second.len() as u64);
    assert!(!history.image_locations.contains_key("u1:0"));
}

#[test]
fn history_image_ids_skip_entries_without_ids() {
    let bytes = b"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"aGk=\",\"mimeType\":\"image/png\"}]}}\n";
    let history = parse_history(bytes);
    assert!(history.image_locations.is_empty());
    let serialized = serde_json::to_string(&history.events).unwrap();
    assert!(!serialized.contains("mimeType"));
}

#[test]
fn branch_metadata_follows_selected_parent_chain() {
    let bytes = concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
        "{\"type\":\"model_change\",\"id\":\"m1\",\"parentId\":null,\"provider\":\"p\",\"modelId\":\"base\"}\n",
        "{\"type\":\"model_change\",\"id\":\"m-old\",\"parentId\":\"m1\",\"provider\":\"p\",\"modelId\":\"old\"}\n",
        "{\"type\":\"model_change\",\"id\":\"m-new\",\"parentId\":\"m1\",\"provider\":\"p\",\"modelId\":\"new\"}\n"
    ).as_bytes();
    let history = parse_history(bytes);
    assert_eq!(history.model.unwrap().id, "new");
}

#[test]
fn eof_after_tool_use_is_interrupted() {
    let bytes = concat!(
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
        "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"t1\",\"name\":\"bash\",\"arguments\":{}}],\"stopReason\":\"toolUse\"}}\n"
    ).as_bytes();
    let history = parse_history(bytes);
    assert!(matches!(
        history.events.last(),
        Some(ConversationEventDto::AssistantTurnEnd {
            completion: TurnCompletion::Interrupted,
            ..
        })
    ));
}

#[test]
fn history_stats_restore_token_breakdown_and_context_usage() {
    let bytes = concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
        "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"call-1\",\"name\":\"read\",\"arguments\":{}}],\"usage\":{\"input\":10,\"output\":5,\"cacheRead\":20,\"cacheWrite\":2,\"totalTokens\":37,\"cost\":{\"total\":0.01}},\"stopReason\":\"toolUse\"}}\n",
        "{\"type\":\"message\",\"id\":\"t1\",\"parentId\":\"a1\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"call-1\",\"toolName\":\"read\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input\":1,\"output\":2,\"cacheRead\":3,\"cacheWrite\":4,\"totalTokens\":10,\"cost\":{\"total\":0.002}}}}\n",
        "{\"type\":\"message\",\"id\":\"a2\",\"parentId\":\"t1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":3,\"output\":7,\"cacheRead\":40,\"cacheWrite\":0,\"totalTokens\":50,\"cost\":{\"total\":0.02}},\"stopReason\":\"stop\"}}\n"
    )
    .as_bytes();

    let history = parse_history(bytes);
    assert_eq!(history.stats.user_messages, 1);
    assert_eq!(history.stats.assistant_messages, 2);
    assert_eq!(history.stats.tool_calls, 1);
    assert_eq!(history.stats.tool_results, 1);
    assert_eq!(history.stats.total_messages, 4);
    assert_eq!(history.stats.tokens.input, 14);
    assert_eq!(history.stats.tokens.output, 14);
    assert_eq!(history.stats.tokens.cache_read, 63);
    assert_eq!(history.stats.tokens.cache_write, 6);
    assert_eq!(history.stats.tokens.total, 97);
    assert!((history.stats.cost - 0.032).abs() < f64::EPSILON);
    assert_eq!(history.stats.context_tokens, Some(50));

    // 轮次用量包含 assistant 步骤与工具嵌套调用（a1 + t1 + a2）。
    let turn_usages = history
        .events
        .iter()
        .filter_map(|event| match event {
            ConversationEventDto::AssistantTurnEnd { usage, .. } => usage.as_ref(),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(turn_usages.len(), 1);
    let usage = turn_usages[0];
    assert_eq!(usage.input, 14);
    assert_eq!(usage.output, 14);
    assert_eq!(usage.cache_read, 63);
    assert_eq!(usage.cache_write, 6);
    assert_eq!(usage.total, 97);
    assert!((usage.cost.unwrap() - 0.032).abs() < f64::EPSILON);
}

#[test]
fn context_usage_is_unknown_after_compaction_until_next_assistant_usage() {
    let bytes = concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
        "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":10,\"output\":5,\"cacheRead\":20,\"cacheWrite\":0,\"totalTokens\":35,\"cost\":{\"total\":0.01}},\"stopReason\":\"stop\"}}\n",
        "{\"type\":\"compaction\",\"id\":\"c1\",\"parentId\":\"a1\",\"summary\":\"compact\",\"firstKeptEntryId\":\"u1\"}\n",
        "{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"c1\",\"message\":{\"role\":\"user\",\"content\":\"continue\"}}\n"
    )
    .as_bytes();

    let history = parse_history(bytes);
    assert_eq!(history.stats.context_tokens, None);
    assert_eq!(history.stats.tokens.total, 35);
}

#[test]
fn compaction_entry_projects_a_marker_at_its_branch_position() {
    let bytes = concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
        "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}}\n",
        "{\"type\":\"compaction\",\"id\":\"c1\",\"parentId\":\"a1\",\"timestamp\":\"2026-09-17T06:32:50.047Z\",\"summary\":\"summary text\",\"firstKeptEntryId\":\"u1\",\"tokensBefore\":217975}\n",
        "{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"c1\",\"message\":{\"role\":\"user\",\"content\":\"continue\"}}\n"
    )
    .as_bytes();

    let history = parse_history(bytes);
    let marker_index = history
        .events
        .iter()
        .position(|event| matches!(event, ConversationEventDto::CompactionMarker { .. }))
        .expect("compaction marker");

    assert!(matches!(
        &history.events[marker_index],
        ConversationEventDto::CompactionMarker {
            summary,
            tokens_before: Some(217_975),
            source_entry_id: Some(id),
            ..
        } if summary == "summary text" && id == "c1"
    ));
    assert!(matches!(
        history.events[marker_index - 1],
        ConversationEventDto::AssistantTurnEnd { .. }
    ));
    assert!(matches!(
        history.events[marker_index + 1],
        ConversationEventDto::UserMessageStart { .. }
    ));
}

// --- Incremental history loads -------------------------------------------------

type Projection = (HistoryStorage, Arc<SessionHistoryWindowIndex>);

fn line(value: serde_json::Value) -> String {
    format!("{value}\n")
}

fn user(id: &str, parent: Option<&str>, text: &str) -> String {
    line(serde_json::json!({
        "type": "message", "id": id, "parentId": parent,
        "timestamp": "2026-11-18T00:00:00Z",
        "message": { "role": "user", "content": text },
    }))
}

fn assistant(id: &str, parent: &str, text: &str, stop: &str, total: u64) -> String {
    line(serde_json::json!({
        "type": "message", "id": id, "parentId": parent,
        "message": {
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "think" },
                { "type": "text", "text": text },
                { "type": "toolCall", "id": format!("{id}-call"), "name": "read", "arguments": { "path": text } },
            ],
            "usage": { "input": total / 2, "output": total - total / 2, "totalTokens": total, "cost": { "total": 0.1 } },
            "stopReason": stop,
        },
    }))
}

fn tool_result(id: &str, parent: &str) -> String {
    line(serde_json::json!({
        "type": "message", "id": id, "parentId": parent,
        "message": {
            "role": "toolResult", "toolCallId": format!("{parent}-call"), "toolName": "read",
            "content": [{ "type": "text", "text": "ok" }],
            "usage": { "input": 1, "output": 2, "cost": { "total": 0.3 } },
        },
    }))
}

fn header() -> String {
    line(serde_json::json!({ "type": "session", "version": 3, "id": "session-a" }))
}

/// header, u1, a1, t1, a1b, u2, a2: the checkpoint is u2.
fn base_session() -> String {
    [
        header(),
        user("u1", None, "first"),
        assistant("a1", "u1", "one", "toolUse", 30),
        tool_result("t1", "a1"),
        assistant("a1b", "t1", "one done", "stop", 40),
        user("u2", Some("a1b"), "second"),
        assistant("a2", "u2", "two", "stop", 50),
    ]
    .concat()
}

fn full_projection(bytes: &[u8]) -> Projection {
    let mut parser = HistoryParser::default();
    for chunk in bytes.chunks(13) {
        parser.push(chunk);
    }
    let (serialized, index) = serialize_windowed_history(parser.finish()).unwrap();
    (HistoryStorage::Memory(serialized), index)
}

fn resumed_projection(
    previous: &Projection,
    bytes: &[u8],
    prefer_disk: bool,
) -> Option<Projection> {
    let state = previous.1.incremental.clone()?;
    assert!(state.resumable());
    let start = (state.checkpoint.file_offset as usize).min(bytes.len());
    let images = state.prefix_image_locations(&previous.1.image_locations);
    let mut parser = HistoryParser::resume(state, images, None);
    for chunk in bytes[start..].chunks(5) {
        parser.push(chunk);
    }
    let history = parser.finish_resumed()?;
    Some(extend_projection(&previous.0, &previous.1, history, prefer_disk).unwrap())
}

fn storage_bytes(storage: &HistoryStorage) -> Vec<u8> {
    match storage {
        HistoryStorage::Memory(bytes) => bytes.as_ref().clone(),
        HistoryStorage::Disk(file) => file.read_prefix(file.bytes).unwrap(),
    }
}

fn memory_projection(bytes: &[u8]) -> (Arc<Vec<u8>>, Arc<SessionHistoryWindowIndex>) {
    match full_projection(bytes) {
        (HistoryStorage::Memory(serialized), index) => (serialized, index),
        (HistoryStorage::Disk(_), _) => unreachable!("full projections start in memory"),
    }
}

fn assert_same_projection(actual: &Projection, expected: &Projection) {
    assert_eq!(
        String::from_utf8(storage_bytes(&actual.0)).unwrap(),
        String::from_utf8(storage_bytes(&expected.0)).unwrap()
    );
    let (actual, expected) = (&actual.1, &expected.1);
    assert_eq!(actual.events_content_start, expected.events_content_start);
    assert_eq!(actual.events_content_end, expected.events_content_end);
    assert_eq!(actual.message_ranges, expected.message_ranges);
    assert_eq!(actual.directory_ranges, expected.directory_ranges);
    assert_eq!(
        String::from_utf8_lossy(&actual.message_index_json),
        String::from_utf8_lossy(&expected.message_index_json)
    );
    assert_eq!(actual.image_locations, expected.image_locations);
    let resume_point = |index: &SessionHistoryWindowIndex| {
        index.incremental.as_ref().map(|state| {
            (
                state.checkpoint.clone(),
                state.committed_offset,
                state.committed_digest,
            )
        })
    };
    assert_eq!(resume_point(actual), resume_point(expected));
}

/// Projects `old`, resumes it over `new`, and checks the result against a full parse.
fn assert_incremental_matches_full(old: &str, new: &str) -> Projection {
    let previous = full_projection(old.as_bytes());
    let resumed = resumed_projection(&previous, new.as_bytes(), false)
        .expect("append should extend the cached projection");
    assert_same_projection(&resumed, &full_projection(new.as_bytes()));
    resumed
}

fn assert_falls_back(old: &str, new: &str) {
    let previous = full_projection(old.as_bytes());
    assert!(previous.1.incremental.is_some());
    assert!(resumed_projection(&previous, new.as_bytes(), false).is_none());
}

#[test]
fn incremental_load_matches_full_parse_after_an_append() {
    let old = base_session();
    let new = [
        old.clone(),
        user("u3", Some("a2"), "third"),
        assistant("a3", "u3", "three", "stop", 60),
    ]
    .concat();
    let resumed = assert_incremental_matches_full(&old, &new);
    let state = resumed.1.incremental.as_ref().unwrap();
    assert_eq!(state.checkpoint.entry_id, "u3");
    assert_eq!(state.updates, 1);
}

#[test]
fn incremental_load_reads_only_from_the_checkpoint() {
    let old = base_session();
    let previous = full_projection(old.as_bytes());
    let state = previous.1.incremental.as_ref().unwrap();
    let u2_line = old.find("\"id\":\"u2\"").unwrap();
    let u2_offset = old[..u2_line].rfind('\n').unwrap() + 1;
    assert_eq!(state.checkpoint.entry_id, "u2");
    assert_eq!(state.checkpoint.file_offset as usize, u2_offset);
    assert_eq!(state.committed_offset as usize, old.len());
    // Bytes before the checkpoint are never fed to the resumed parser.
    let mut changed_prefix = old.clone().into_bytes();
    changed_prefix[0] = b'X';
    let resumed = resumed_projection(&previous, &changed_prefix, false).unwrap();
    assert_same_projection(&resumed, &previous);
}

#[test]
fn incremental_loads_chain_across_turns_and_count_updates() {
    let mut text = base_session();
    let mut projection = full_projection(text.as_bytes());
    let mut parent = "a2".to_owned();
    for turn in 0..5_u32 {
        let user_id = format!("u-{turn}");
        let answer_id = format!("a-{turn}");
        text.push_str(&user(&user_id, Some(&parent), &format!("turn {turn}")));
        text.push_str(&assistant(&answer_id, &user_id, "partial", "toolUse", 70));
        text.push_str(&tool_result(&format!("t-{turn}"), &answer_id));
        // Resume mid-turn too: the open turn is projected as interrupted.
        let resumed = resumed_projection(&projection, text.as_bytes(), false).unwrap();
        assert_same_projection(&resumed, &full_projection(text.as_bytes()));
        let final_id = format!("af-{turn}");
        text.push_str(&assistant(
            &final_id,
            &format!("t-{turn}"),
            "done",
            "stop",
            80,
        ));
        projection = resumed_projection(&resumed, text.as_bytes(), false).unwrap();
        assert_same_projection(&projection, &full_projection(text.as_bytes()));
        assert_eq!(
            projection.1.incremental.as_ref().unwrap().updates,
            2 * turn + 2
        );
        parent = final_id;
    }
}

#[test]
fn incremental_load_rereads_a_half_written_last_line() {
    let old = base_session();
    let next = user("u3", Some("a2"), "third");
    let answer = assistant("a3", "u3", "three", "stop", 60);
    let complete = [old.as_str(), next.as_str(), answer.as_str()].concat();

    // A torn line is parsed like a full read but is reread next time.
    let torn = [old.as_str(), next.as_str(), &answer[..answer.len() / 2]].concat();
    let torn_projection = assert_incremental_matches_full(&old, &torn);
    let state = torn_projection.1.incremental.as_ref().unwrap();
    assert_eq!(state.checkpoint.entry_id, "u3");
    assert_eq!(state.committed_offset as usize, old.len() + next.len());
    let resumed = resumed_projection(&torn_projection, complete.as_bytes(), false).unwrap();
    assert_same_projection(&resumed, &full_projection(complete.as_bytes()));

    // A complete JSON value still waiting for its newline cannot be a checkpoint.
    let unterminated = [old.as_str(), next.trim_end()].concat();
    let unterminated_projection = assert_incremental_matches_full(&old, &unterminated);
    let state = unterminated_projection.1.incremental.as_ref().unwrap();
    assert_eq!(state.checkpoint.entry_id, "u2");
    let resumed = resumed_projection(&unterminated_projection, complete.as_bytes(), false).unwrap();
    assert_same_projection(&resumed, &full_projection(complete.as_bytes()));
}

#[test]
fn incremental_load_follows_a_branch_switch_after_the_checkpoint() {
    let old = base_session();
    let new = [
        old.clone(),
        assistant("a2-retry", "u2", "two again", "stop", 55),
    ]
    .concat();
    let resumed = assert_incremental_matches_full(&old, &new);
    let events = String::from_utf8(storage_bytes(&resumed.0)).unwrap();
    assert!(events.contains("two again"));
    assert!(!events.contains("\"delta\":\"two\""));
}

#[test]
fn incremental_load_matches_full_parse_with_compaction_in_the_tail() {
    let old = base_session();
    let compacted = [
        old.clone(),
        line(serde_json::json!({
            "type": "compaction", "id": "c1", "parentId": "a2", "summary": "summary",
            "tokensBefore": 1000, "firstKeptEntryId": "u2",
            "usage": { "input": 5, "output": 6, "cost": { "total": 0.7 } },
        })),
    ]
    .concat();
    let after_compaction = assert_incremental_matches_full(&old, &compacted);
    let state = after_compaction.1.incremental.as_ref().unwrap();
    assert_eq!(state.checkpoint.entry_id, "c1");
    let serialized = String::from_utf8(storage_bytes(&after_compaction.0)).unwrap();
    assert!(serialized.contains("\"contextTokens\":null"));

    let continued = [
        compacted.clone(),
        user("u3", Some("c1"), "after compaction"),
        assistant("a3", "u3", "fresh", "stop", 90),
    ]
    .concat();
    let resumed = resumed_projection(&after_compaction, continued.as_bytes(), false).unwrap();
    assert_same_projection(&resumed, &full_projection(continued.as_bytes()));
}

#[test]
fn incremental_load_keeps_context_tokens_from_before_the_checkpoint() {
    let old = base_session();
    // The tail after u3 has no usable assistant usage, so context comes from a2.
    let new = [
        old.clone(),
        user("u3", Some("a2"), "third"),
        assistant("a3", "u3", "aborted", "aborted", 99),
    ]
    .concat();
    let resumed = assert_incremental_matches_full(&old, &new);
    let serialized = String::from_utf8(storage_bytes(&resumed.0)).unwrap();
    assert!(serialized.contains("\"contextTokens\":50"));
}

#[test]
fn incremental_load_indexes_images_in_the_tail() {
    let image_user = |id: &str, parent: &str| {
        line(serde_json::json!({
            "type": "message", "id": id, "parentId": parent,
            "message": { "role": "user", "content": [
                { "type": "text", "text": "look" },
                { "type": "image", "data": "aGk=", "mimeType": "image/png" },
            ] },
        }))
    };
    let old = [
        base_session(),
        image_user("u3", "a2"),
        assistant("a3", "u3", "seen", "stop", 10),
    ]
    .concat();
    let new = [old.clone(), image_user("u4", "a3")].concat();
    let resumed = assert_incremental_matches_full(&old, &new);
    assert!(resumed.1.image_locations.contains_key("u3:1"));
    assert!(resumed.1.image_locations.contains_key("u4:1"));
}

#[test]
fn incremental_load_tracks_metadata_changes_in_the_tail() {
    let old = [
        base_session(),
        line(serde_json::json!({
            "type": "model_change", "id": "m1", "parentId": "a2", "provider": "p", "modelId": "before",
        })),
        line(serde_json::json!({
            "type": "session_info", "id": "n1", "parentId": "m1", "name": "old name",
        })),
    ]
    .concat();
    // Metadata before the checkpoint carries over unchanged.
    let carried = [old.clone(), user("u3", Some("n1"), "third")].concat();
    let resumed = assert_incremental_matches_full(&old, &carried);
    let serialized = String::from_utf8(storage_bytes(&resumed.0)).unwrap();
    assert!(serialized.contains("\"id\":\"before\""));
    assert!(serialized.contains("\"name\":\"old name\""));

    let changed = [
        carried.clone(),
        line(serde_json::json!({
            "type": "model_change", "id": "m2", "parentId": "u3", "provider": "p", "modelId": "after",
        })),
        line(serde_json::json!({
            "type": "thinking_level_change", "id": "k1", "parentId": "m2", "thinkingLevel": "high",
        })),
        line(serde_json::json!({
            "type": "session_info", "id": "n2", "parentId": "k1", "name": "new name",
        })),
        assistant("a3", "n2", "three", "stop", 60),
    ]
    .concat();
    let resumed = resumed_projection(&resumed, changed.as_bytes(), false).unwrap();
    assert_same_projection(&resumed, &full_projection(changed.as_bytes()));
    let serialized = String::from_utf8(storage_bytes(&resumed.0)).unwrap();
    assert!(serialized.contains("\"id\":\"after\""));
    assert!(serialized.contains("\"thinkingLevel\":\"high\""));
    assert!(serialized.contains("\"name\":\"new name\""));
}

#[test]
fn incremental_load_with_unchanged_bytes_reproduces_the_projection() {
    // Same size, only the mtime changed.
    let old = base_session();
    let previous = full_projection(old.as_bytes());
    let resumed = resumed_projection(&previous, old.as_bytes(), false).unwrap();
    assert_same_projection(&resumed, &previous);
}

#[test]
fn incremental_load_extends_a_disk_projection() {
    let old = base_session();
    let (serialized, index) = memory_projection(old.as_bytes());
    let previous = (
        HistoryStorage::Disk(Arc::new(DiskHistory::create(&serialized).unwrap())),
        index,
    );
    let new = [old.clone(), user("u3", Some("a2"), "third")].concat();
    let resumed = resumed_projection(&previous, new.as_bytes(), true).unwrap();
    assert!(matches!(resumed.0, HistoryStorage::Disk(_)));
    assert_same_projection(&resumed, &full_projection(new.as_bytes()));
    // A disk projection is extended into memory when the result fits there.
    let resumed = resumed_projection(&previous, new.as_bytes(), false).unwrap();
    assert!(matches!(resumed.0, HistoryStorage::Memory(_)));
    assert_same_projection(&resumed, &full_projection(new.as_bytes()));
}

#[test]
fn incremental_load_falls_back_when_the_source_is_truncated() {
    let old = base_session();
    assert_falls_back(&old, &old[..old.len() - 10]);
    assert_falls_back(&old, &old[..old.find("\"id\":\"u2\"").unwrap()]);
}

#[test]
fn incremental_load_falls_back_when_verified_bytes_change() {
    let old = base_session();
    // A same-size rewrite, like a migration rewriting entries in place.
    let rewritten = old.replace("\"text\":\"two\"", "\"text\":\"TWO\"");
    assert_ne!(rewritten, old);
    assert_eq!(rewritten.len(), old.len());
    assert_falls_back(&old, &rewritten);
    assert_falls_back(&old, &[rewritten, user("u3", Some("a2"), "third")].concat());
}

#[test]
fn incremental_load_falls_back_when_the_branch_leaves_the_checkpoint() {
    let old = base_session();
    // Back to a1b, before the checkpoint u2.
    assert_falls_back(
        &old,
        &[old.clone(), user("u2-alt", Some("a1b"), "retry")].concat(),
    );
    // A dangling parent never reaches the checkpoint.
    assert_falls_back(
        &old,
        &[old.clone(), user("u3", Some("missing"), "lost")].concat(),
    );
}

#[test]
fn incremental_load_falls_back_on_a_parent_cycle() {
    let old = base_session();
    let cycle = [
        old.clone(),
        line(serde_json::json!({ "type": "custom", "id": "x", "parentId": "y" })),
        line(serde_json::json!({ "type": "custom", "id": "y", "parentId": "x" })),
    ]
    .concat();
    assert_falls_back(&old, &cycle);
}

#[test]
fn histories_without_a_complete_checkpoint_are_not_resumable() {
    assert!(full_projection(header().as_bytes()).1.incremental.is_none());
    let no_ids = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n";
    assert!(full_projection(no_ids.as_bytes()).1.incremental.is_none());
    let unterminated = [header(), user("u1", None, "first").trim_end().to_owned()].concat();
    assert!(
        full_projection(unterminated.as_bytes())
            .1
            .incremental
            .is_none()
    );
}

#[test]
fn incremental_updates_stop_at_the_limit() {
    let previous = full_projection(base_session().as_bytes());
    let mut state = previous.1.incremental.clone().unwrap();
    assert_eq!(state.updates, 0);
    state.updates = MAX_INCREMENTAL_UPDATES - 1;
    assert!(state.resumable());
    state.updates = MAX_INCREMENTAL_UPDATES;
    assert!(!state.resumable());
}

#[test]
fn cached_projection_survives_a_replacement_that_cannot_be_cached() {
    let mut cache = SessionHistoryCache::default();
    let old = base_session();
    let (serialized, index) = memory_projection(old.as_bytes());
    let old_fingerprint = SessionFileFingerprint {
        file_size: old.len() as u64,
        file_mtime_ns: 1,
    };
    cache.insert_disk(
        "key".to_owned(),
        old_fingerprint,
        Arc::new(DiskHistory::create(&serialized).unwrap()),
        Arc::clone(&index),
    );
    let oversized = SessionHistoryWindowIndex {
        message_index_json: Arc::new(Vec::with_capacity(65 * 1024 * 1024)),
        ..index.as_ref().clone()
    };
    cache.insert_disk(
        "key".to_owned(),
        SessionFileFingerprint {
            file_size: old.len() as u64 + 1,
            file_mtime_ns: 2,
        },
        Arc::new(DiskHistory::create(&serialized).unwrap()),
        Arc::new(oversized),
    );
    assert!(cache.get_disk("key", old_fingerprint).is_some());
    // Any later fingerprint can still be extended from the cached checkpoint.
    assert!(cache.incremental_base("key").is_some());
}
