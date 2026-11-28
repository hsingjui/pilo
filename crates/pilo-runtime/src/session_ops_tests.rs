use serde_json::json;

use super::*;

#[test]
fn only_cli_created_ids_make_cli_session_keys() {
    let cli_id = format!("{NEW_SESSION_ID_PREFIX}{}", "0123456789abcdef".repeat(2));
    assert!(is_cli_session_key(&chat_key("project", &cli_id)));
    assert!(!is_cli_session_key(&chat_key("project", "temporary-1")));
    assert!(!is_cli_session_key(&chat_key("project", "cli-0123")));
    assert!(!is_cli_session_key(&cli_id));
}

#[test]
fn last_assistant_message_skips_empty_and_tool_only_messages() {
    let history = json!({"events": [
        {"type": "user_message_start", "text": "hi"},
        {"type": "assistant_message_start"},
        {"type": "assistant_text_delta", "delta": "Hel"},
        {"type": "assistant_text_delta", "delta": "lo"},
        {"type": "assistant_message_start"},
        {"type": "tool_execution_start"},
    ]});
    assert_eq!(last_assistant_message(&history).as_deref(), Some("Hello"));
    let wrapped = json!({"history": history});
    assert_eq!(last_assistant_message(&wrapped).as_deref(), Some("Hello"));
    assert_eq!(last_assistant_message(&json!({"events": []})), None);
}

#[test]
fn running_tools_are_started_but_not_ended() {
    let event = |end: bool, id: &str, name: &str| {
        std::sync::Arc::new(if end {
            RuntimeEvent::ToolExecutionEnd {
                generation: 1,
                tool_call_id: id.into(),
                tool_name: name.into(),
                result: Value::Null,
                is_error: false,
            }
        } else {
            RuntimeEvent::ToolExecutionStart {
                generation: 1,
                tool_call_id: id.into(),
                tool_name: name.into(),
                args: Value::Null,
            }
        })
    };
    let events = [
        event(false, "a", "bash"),
        event(false, "b", "read"),
        event(true, "a", "bash"),
    ];
    assert_eq!(running_tool_names(&events), ["read"]);
}

#[test]
fn messages_and_titles_are_validated() {
    for message in ["", "   ", "/compact", " /model x"] {
        assert!(validate_message(message).is_err(), "{message:?}");
    }
    assert!(validate_message(&"x".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
    assert!(validate_message("fix the bug").is_ok());
    assert!(validate_title("a\nb").is_err());
    assert!(validate_title(" ").is_err());
    assert!(validate_title("Release notes").is_ok());
}
