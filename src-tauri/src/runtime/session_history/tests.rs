use std::sync::Arc;

use super::{
    cache::{
        SESSION_HISTORY_CACHE_CAPACITY, SESSION_HISTORY_CACHE_MAX_ESTIMATED_BYTES,
        SessionFileFingerprint, SessionHistoryCache, fingerprint_from_metadata,
    },
    parser::{HistoryParser, parse_history},
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
