use super::*;
use crate::events::ExtensionUiRequestPayload;
use crate::token_usage::TokenUsage;

#[test]
fn maps_assistant_message_start_instead_of_agent_start() {
    let mut adapter = PiEventAdapter::default();
    assert!(
        adapter
            .adapt(3, &serde_json::json!({ "type": "agent_start" }))
            .is_empty()
    );
    assert_eq!(
        adapter.adapt(
            3,
            &serde_json::json!({
                "type": "message_start",
                "message": { "role": "assistant", "content": [] }
            })
        ),
        [RuntimeEvent::AssistantMessageStart { generation: 3 }]
    );
}

#[test]
fn maps_text_delta_without_exposing_raw_message() {
    let mut adapter = PiEventAdapter::default();
    let events = adapter.adapt(
        4,
        &serde_json::json!({
            "type": "message_update",
            "usage": { "input": 1, "output": 2 },
            "assistantMessageEvent": {
                "type": "text_delta",
                "contentIndex": 0,
                "delta": "hello"
            }
        }),
    );

    assert_eq!(
        events,
        [RuntimeEvent::AssistantTextDelta {
            generation: 4,
            delta: "hello".to_owned(),
        }]
    );
}

#[test]
fn reconciles_authoritative_text_across_assistant_messages() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "before tool" },
                        { "type": "toolCall", "id": "call-1", "name": "bash", "arguments": {} }
                    ],
                    "stopReason": "toolUse"
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 4,
            text: "before tool".to_owned(),
        }]
    );
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": " after tool" }],
                    "stopReason": "stop"
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 4,
            text: "before tool after tool".to_owned(),
        }]
    );
}

#[test]
fn user_message_start_begins_a_new_conversation_turn() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "first reply" }],
                    "stopReason": "stop"
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 4,
            text: "first reply".to_owned(),
        }]
    );
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_start",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "follow up" }]
                }
            })
        ),
        [RuntimeEvent::UserMessageStart {
            generation: 4,
            text: "follow up".to_owned(),
        }]
    );
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "second reply" }],
                    "stopReason": "stop"
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 4,
            text: "second reply".to_owned(),
        }]
    );
}

#[test]
fn maps_queue_update_for_follow_up_ui() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            7,
            &serde_json::json!({
                "type": "queue_update",
                "steering": ["change direction"],
                "followUp": ["then summarize", "then test"]
            })
        ),
        [RuntimeEvent::QueueUpdate {
            generation: 7,
            steering: vec!["change direction".to_owned()],
            follow_up: vec!["then summarize".to_owned(), "then test".to_owned()],
        }]
    );
}

#[test]
fn maps_thinking_stream_lifecycle() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_start", "contentIndex": 0 }
            })
        ),
        [RuntimeEvent::AssistantThinkingStart { generation: 4 }]
    );
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "thinking_delta",
                    "contentIndex": 0,
                    "delta": "considering"
                }
            })
        ),
        [RuntimeEvent::AssistantThinkingDelta {
            generation: 4,
            delta: "considering".to_owned(),
        }]
    );
    assert_eq!(
        adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_end", "contentIndex": 0 }
            })
        ),
        [RuntimeEvent::AssistantThinkingEnd { generation: 4 }]
    );
}

#[test]
fn maps_tool_execution_lifecycle_with_update_args() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            8,
            &serde_json::json!({
                "type": "tool_execution_start",
                "toolCallId": "call-1",
                "toolName": "bash",
                "args": { "command": "pwd" }
            })
        ),
        [RuntimeEvent::ToolExecutionStart {
            generation: 8,
            tool_call_id: "call-1".to_owned(),
            tool_name: "bash".to_owned(),
            args: serde_json::json!({ "command": "pwd" }),
        }]
    );
    assert_eq!(
        adapter.adapt(
            8,
            &serde_json::json!({
                "type": "tool_execution_update",
                "toolCallId": "call-1",
                "toolName": "bash",
                "args": { "command": "pwd" },
                "partialResult": { "content": [{ "type": "text", "text": "/repo" }] }
            })
        ),
        [RuntimeEvent::ToolExecutionUpdate {
            generation: 8,
            tool_call_id: "call-1".to_owned(),
            tool_name: "bash".to_owned(),
            args: serde_json::json!({ "command": "pwd" }),
            partial_result: serde_json::json!({
                "content": [{ "type": "text", "text": "/repo" }]
            }),
        }]
    );
}

#[test]
fn agent_end_does_not_finish_until_agent_settled() {
    let mut adapter = PiEventAdapter::default();
    assert!(
        adapter
            .adapt(
                5,
                &serde_json::json!({
                    "type": "agent_end",
                    "willRetry": false,
                    "messages": [{
                        "role": "assistant",
                        "content": [],
                        "stopReason": "toolUse"
                    }]
                })
            )
            .is_empty()
    );

    // 用量只认 message_end；agent_end 里的 usage 不得重复计入。
    assert_eq!(
        adapter.adapt(
            5,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "stopReason": "stop",
                    "usage": { "input": 10, "output": 5 }
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 5,
            text: String::new(),
        }]
    );

    assert_eq!(
        adapter.adapt(
            5,
            &serde_json::json!({
                "type": "agent_end",
                "willRetry": false,
                "messages": [{
                    "role": "assistant",
                    "content": [],
                    "stopReason": "stop",
                    "usage": { "input": 10, "output": 5 }
                }]
            })
        ),
        []
    );

    assert_eq!(
        adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
        [RuntimeEvent::AssistantMessageEnd {
            generation: 5,
            stop_reason: Some("stop".to_owned()),
            error_message: None,
            usage: Some(TokenUsage {
                input: 10,
                output: 5,
                cache_read: 0,
                cache_write: 0,
                total: 15,
                cost: None,
            }),
        }]
    );
}

/// 自动重试会在一次 agent_settled 前产生多次 agent_end；每次运行各自的
/// assistant 消息用量都必须保留，不能互相覆盖。
#[test]
fn usage_accumulates_across_auto_retries() {
    let mut adapter = PiEventAdapter::default();

    for (attempt, (input, output)) in [(10, 5), (100, 50)].into_iter().enumerate() {
        let usage = serde_json::json!({ "input": input, "output": output });
        assert_eq!(
            adapter.adapt(
                5,
                &serde_json::json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "stopReason": "error",
                        "usage": usage
                    }
                })
            ),
            [RuntimeEvent::AssistantTextSnapshot {
                generation: 5,
                text: String::new(),
            }]
        );
        assert!(
            adapter
                .adapt(
                    5,
                    &serde_json::json!({
                        "type": "agent_end",
                        "willRetry": attempt == 0,
                        "messages": [{
                            "role": "assistant",
                            "content": [],
                            "stopReason": "error",
                            "usage": usage
                        }]
                    })
                )
                .is_empty()
        );
    }

    assert_eq!(
        adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
        [RuntimeEvent::AssistantMessageEnd {
            generation: 5,
            stop_reason: Some("error".to_owned()),
            error_message: None,
            usage: Some(TokenUsage {
                input: 110,
                output: 55,
                cache_read: 0,
                cache_write: 0,
                total: 165,
                cost: None,
            }),
        }]
    );
}

#[test]
fn steering_preserves_each_segment_usage_without_ending_the_run() {
    let mut adapter = PiEventAdapter::default();
    for (input, output) in [(10, 5), (100, 50)] {
        adapter.adapt(
            5,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "stopReason": "toolUse",
                    "usage": { "input": input, "output": output }
                }
            }),
        );
        assert_eq!(
            adapter.adapt(
                5,
                &serde_json::json!({
                    "type": "message_start",
                    "message": { "role": "user", "content": "steer" }
                })
            ),
            [
                RuntimeEvent::AssistantUsageUpdate {
                    generation: 5,
                    usage: TokenUsage {
                        input,
                        output,
                        cache_read: 0,
                        cache_write: 0,
                        total: input + output,
                        cost: None,
                    },
                },
                RuntimeEvent::UserMessageStart {
                    generation: 5,
                    text: "steer".to_owned(),
                },
            ]
        );
    }
    adapter.adapt(
        5,
        &serde_json::json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [],
                "stopReason": "stop",
                "usage": { "input": 3, "output": 7 }
            }
        }),
    );
    assert_eq!(
        adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
        [RuntimeEvent::AssistantMessageEnd {
            generation: 5,
            stop_reason: Some("stop".to_owned()),
            error_message: None,
            usage: Some(TokenUsage {
                input: 3,
                output: 7,
                cache_read: 0,
                cache_write: 0,
                total: 10,
                cost: None,
            }),
        }]
    );
}

#[test]
fn usage_includes_tool_results_without_counting_agent_end_twice() {
    let mut adapter = PiEventAdapter::default();
    let messages = serde_json::json!([
        {
            "role": "assistant", "content": [],
            "usage": {
                "input": 10, "output": 5, "cacheRead": 20, "cacheWrite": 2,
                "totalTokens": 37, "cost": { "total": 0.01 }
            }
        },
        {
            "role": "toolResult", "content": [],
            "usage": {
                "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4,
                "totalTokens": 10, "cost": { "total": 0.002 }
            }
        },
        {
            "role": "assistant", "content": [], "stopReason": "stop",
            "usage": {
                "input": 3, "output": 7, "cacheRead": 40, "cacheWrite": 0,
                "totalTokens": 50, "cost": { "total": 0.02 }
            }
        }
    ]);
    for message in messages.as_array().unwrap() {
        let events = adapter.adapt(
            5,
            &serde_json::json!({ "type": "message_end", "message": message }),
        );
        if message["role"] == "toolResult" {
            assert!(events.is_empty());
        }
    }
    assert!(
        adapter
            .adapt(
                5,
                &serde_json::json!({ "type": "agent_end", "messages": messages })
            )
            .is_empty()
    );
    let events = adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" }));
    let [
        RuntimeEvent::AssistantMessageEnd {
            usage: Some(usage), ..
        },
    ] = events.as_slice()
    else {
        panic!("expected settled usage");
    };
    assert_eq!(usage.input, 14);
    assert_eq!(usage.output, 14);
    assert_eq!(usage.cache_read, 63);
    assert_eq!(usage.cache_write, 6);
    assert_eq!(usage.total, 97);
    assert!((usage.cost.unwrap() - 0.032).abs() < f64::EPSILON);
}

#[test]
fn settled_uses_latest_error_metadata_and_resets_state() {
    let mut adapter = PiEventAdapter::default();
    assert!(
        adapter
            .adapt(
                5,
                &serde_json::json!({
                    "type": "agent_end",
                    "messages": [{
                        "role": "assistant",
                        "content": [],
                        "stopReason": "error",
                        "errorMessage": "provider failed"
                    }]
                })
            )
            .is_empty()
    );
    assert_eq!(
        adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
        [RuntimeEvent::AssistantMessageEnd {
            generation: 5,
            stop_reason: Some("error".to_owned()),
            error_message: Some("provider failed".to_owned()),
            usage: None,
        }]
    );
    assert_eq!(
        adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
        [RuntimeEvent::AssistantMessageEnd {
            generation: 5,
            stop_reason: None,
            error_message: None,
            usage: None,
        }]
    );
}

#[test]
fn maps_failed_rpc_response_to_runtime_error() {
    let mut adapter = PiEventAdapter::default();
    let events = adapter.adapt(
        6,
        &serde_json::json!({
            "type": "response",
            "command": "prompt",
            "success": false,
            "error": "Agent is already streaming"
        }),
    );

    assert_eq!(
        events,
        [RuntimeEvent::RuntimeError {
            generation: 6,
            code: RuntimeErrorCode::RpcResponse,
            message: "Agent is already streaming".to_owned(),
        }]
    );
}

#[test]
fn correlated_rpc_failure_is_handled_by_the_request_caller() {
    let mut adapter = PiEventAdapter::default();
    assert!(
        adapter
            .adapt(
                6,
                &serde_json::json!({
                    "id": "pilo-123-1",
                    "type": "response",
                    "command": "follow_up",
                    "success": false,
                    "error": "Extension commands cannot be queued"
                })
            )
            .is_empty()
    );
}

#[test]
fn maps_compaction_and_retry_events() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            9,
            &serde_json::json!({
                "type": "compaction_start",
                "reason": "threshold"
            })
        ),
        [RuntimeEvent::CompactionStart {
            generation: 9,
            reason: "threshold".to_owned(),
        }]
    );
    assert_eq!(
        adapter.adapt(
            9,
            &serde_json::json!({
                "type": "auto_retry_start",
                "attempt": 2,
                "maxAttempts": 3,
                "delayMs": 4000,
                "errorMessage": "overloaded"
            })
        ),
        [RuntimeEvent::AutoRetryStart {
            generation: 9,
            attempt: 2,
            max_attempts: 3,
            delay_ms: 4000,
            error_message: "overloaded".to_owned(),
        }]
    );
}

#[test]
fn compaction_end_resets_finalized_text_for_subsequent_snapshots() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            3,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "before compaction" }]
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 3,
            text: "before compaction".to_owned(),
        }]
    );
    let _ = adapter.adapt(
        3,
        &serde_json::json!({
            "type": "compaction_end",
            "reason": "threshold",
            "result": { "summary": "summary", "tokensBefore": 1000 },
            "aborted": false,
            "willRetry": false
        }),
    );
    assert_eq!(
        adapter.adapt(
            3,
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "after compaction" }]
                }
            })
        ),
        [RuntimeEvent::AssistantTextSnapshot {
            generation: 3,
            text: "after compaction".to_owned(),
        }]
    );
}

#[test]
fn maps_extension_ui_request_fields() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            11,
            &serde_json::json!({
                "type": "extension_ui_request",
                "id": "ui-1",
                "method": "select",
                "title": "Choose",
                "options": ["A", "B"],
                "timeout": 5000
            })
        ),
        [RuntimeEvent::ExtensionUiRequest {
            generation: 11,
            request: Box::new(ExtensionUiRequestPayload {
                id: "ui-1".to_owned(),
                method: "select".to_owned(),
                title: Some("Choose".to_owned()),
                message: None,
                options: vec!["A".to_owned(), "B".to_owned()],
                placeholder: None,
                prefill: None,
                timeout: Some(5000),
                notify_type: None,
                status_key: None,
                status_text: None,
                widget_key: None,
                widget_lines: None,
                widget_placement: None,
                text: None,
            }),
        }]
    );
}

#[test]
fn maps_extension_notify_request() {
    let mut adapter = PiEventAdapter::default();
    assert_eq!(
        adapter.adapt(
            12,
            &serde_json::json!({
                "type": "extension_ui_request",
                "id": "ui-notify-1",
                "method": "notify",
                "message": "Command blocked by user",
                "notifyType": "warning"
            })
        ),
        [RuntimeEvent::ExtensionUiRequest {
            generation: 12,
            request: Box::new(ExtensionUiRequestPayload {
                id: "ui-notify-1".to_owned(),
                method: "notify".to_owned(),
                title: None,
                message: Some("Command blocked by user".to_owned()),
                options: Vec::new(),
                placeholder: None,
                prefill: None,
                timeout: None,
                notify_type: Some("warning".to_owned()),
                status_key: None,
                status_text: None,
                widget_key: None,
                widget_lines: None,
                widget_placement: None,
                text: None,
            }),
        }]
    );
}
