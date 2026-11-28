use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Barrier, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use serde_json::{Value, json};

use super::*;
use crate::{
    chat_sessions::event_sink::ChatEventSink,
    events::{
        EventBatch, EventQueueLimits, RuntimeEventEnvelope, RuntimeEventSink, RuntimeLogStream,
    },
};

static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Jsonl(PathBuf);

impl Jsonl {
    fn new(bytes: &[u8]) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pilo-turn-{}-{}.jsonl",
            std::process::id(),
            FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).unwrap();
        Self(path)
    }

    fn path(&self) -> String {
        self.0.to_str().unwrap().to_owned()
    }
}

impl Drop for Jsonl {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) fn sink(local: bool) -> ChatEventSink {
    ChatEventSink {
        events: RuntimeEventBus::default(),
        turn: Arc::new(SessionTurn::new(local)),
        session_key: "session".to_owned(),
        project_id: "project".to_owned(),
        control_reply: Arc::new(StdMutex::new(None)),
        initialization_stderr: Arc::new(StdMutex::new(String::new())),
        session_path: Arc::new(StdMutex::new(None)),
        active_turn: Arc::new(AtomicBool::new(false)),
        compacting: Arc::new(AtomicBool::new(false)),
        pending_prompt_id: Arc::new(StdMutex::new(None)),
        closed: Arc::new(AtomicBool::new(false)),
    }
}

fn start(file: &Jsonl, mode: PromptMode) -> PromptStart {
    PromptStart {
        generation: 1,
        path: Some(file.path()),
        id: Some("prompt-1".to_owned()),
        mode,
    }
}

async fn prepare(sink: &ChatEventSink, file: &Jsonl) {
    sink.turn
        .send_prompt(&sink.events, start(file, PromptMode::Idle), || async {
            Ok(())
        })
        .await
        .unwrap();
}

fn live(sink: &ChatEventSink) -> TurnLive {
    sink.events
        .with_publish_lock(|| sink.turn.state.lock().unwrap().projection.snapshot().live)
}

fn user() -> RuntimeEvent {
    RuntimeEvent::UserMessageStart {
        generation: 1,
        text: "prompt".to_owned(),
    }
}
fn text(delta: &str) -> RuntimeEvent {
    RuntimeEvent::AssistantTextDelta {
        generation: 1,
        delta: delta.to_owned(),
    }
}
fn settled() -> RuntimeEvent {
    RuntimeEvent::AssistantMessageEnd {
        generation: 1,
        stop_reason: Some("stop".to_owned()),
        error_message: None,
        usage: None,
    }
}
fn agent_start(sink: &ChatEventSink) {
    sink.turn.agent_start(&sink.events, 1);
}

#[tokio::test]
async fn base_is_captured_before_the_prompt_writer_runs() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    sink.turn
        .send_prompt(&sink.events, start(&file, PromptMode::Idle), || async {
            let snapshot = sink.turn.state.lock().unwrap().projection.snapshot();
            assert_eq!(snapshot.base_size, Some(3));
            assert!(matches!(snapshot.live, TurnLive::Active { .. }));
            OpenOptions::new()
                .append(true)
                .open(&file.0)
                .unwrap()
                .write_all(b"{\"role\":\"user\"}\n")
                .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert!(std::fs::metadata(&file.0).unwrap().len() > 3);
    assert_eq!(
        sink.turn
            .state
            .lock()
            .unwrap()
            .projection
            .snapshot()
            .base_size,
        Some(3)
    );
}

#[tokio::test]
async fn concurrent_publishers_project_the_bus_sequence_order() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    agent_start(&sink);
    sink.send(user());
    let barrier = Arc::new(Barrier::new(8));
    let threads = (0..8)
        .map(|worker| {
            let sink = sink.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for index in 0..32 {
                    sink.send(text(&format!("{worker}:{index}")));
                    sink.send(RuntimeEvent::ToolExecutionUpdate {
                        generation: 1,
                        tool_call_id: format!("{worker}:{index}"),
                        tool_name: "bash".to_owned(),
                        args: json!({}),
                        partial_result: json!({"index": index}),
                    });
                }
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        thread.join().unwrap();
    }
    let replay = sink.events.replay_after(0).unwrap();
    let mut expected = TurnProjection::new(TurnLimits {
        max_events: 2048,
        max_bytes: 16 * 1024 * 1024,
    });
    assert!(expected.begin(3));
    for event in &replay {
        expected.push(event.event.event.clone());
    }
    sink.events.with_publish_lock(|| {
        let state = sink.turn.state.lock().unwrap();
        assert_eq!(state.projection.snapshot(), expected.snapshot());
        assert_eq!(state.sequence, replay.last().unwrap().sequence);
        assert_eq!(state.sequence, sink.events.latest_sequence());
    });
}

#[tokio::test]
async fn idle_events_leave_idle_and_do_not_poison_the_next_prompt() {
    let sink = sink(true);
    for event in [
        RuntimeEvent::ProcessState {
            generation: 1,
            state: PiProcessState::Running,
        },
        RuntimeEvent::RpcMessage {
            generation: 1,
            message: json!({"type": "response", "command": "get_state", "success": true}),
        },
        RuntimeEvent::RuntimeLog {
            generation: 1,
            stream: RuntimeLogStream::Stderr,
            message: "diagnostic".to_owned(),
        },
        RuntimeEvent::QueueUpdate {
            generation: 1,
            steering: vec![],
            follow_up: vec![],
        },
        RuntimeEvent::CompactionStart {
            generation: 1,
            reason: "manual".to_owned(),
        },
        RuntimeEvent::CompactionEnd {
            generation: 1,
            reason: "manual".to_owned(),
            result: None,
            aborted: false,
            will_retry: false,
            error_message: None,
        },
    ] {
        sink.send(event);
        assert_eq!(live(&sink), TurnLive::Idle);
    }
    let file = Jsonl::new(b"{}\n");
    prepare(&sink, &file).await;
    let TurnLive::Active { events } = live(&sink) else {
        panic!("next prompt must be active");
    };
    assert!(events.is_empty());
    sink.send(user());
    let TurnLive::Active { events } = live(&sink) else {
        panic!("prompt user echo must stay active");
    };
    assert_eq!(events.len(), 1);
}

#[test]
fn autonomous_and_attached_turns_are_truncated() {
    for event in [
        user(),
        RuntimeEvent::AssistantMessageStart { generation: 1 },
        RuntimeEvent::PiReattached {
            generation: 1,
            active: true,
            compacting: false,
        },
    ] {
        let sink = sink(true);
        sink.send(event);
        assert_eq!(live(&sink), TurnLive::Truncated);
    }
    let sink = sink(true);
    agent_start(&sink);
    assert_eq!(live(&sink), TurnLive::Truncated);
}

#[tokio::test]
async fn queued_follow_ups_and_second_agent_runs_are_not_recorded_starts() {
    let file = Jsonl::new(b"{}\n");
    for raw_restart in [false, true] {
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        if raw_restart {
            agent_start(&sink);
        } else {
            sink.turn
                .send_prompt(&sink.events, start(&file, PromptMode::Queued), || async {
                    Ok(())
                })
                .await
                .unwrap();
            sink.send(user());
        }
        assert_eq!(live(&sink), TurnLive::Truncated);
    }
}

#[tokio::test]
async fn steer_echoes_remain_in_the_recorded_turn() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    agent_start(&sink);
    sink.send(user());
    sink.send(text("before"));
    sink.turn
        .send_prompt(&sink.events, start(&file, PromptMode::Steer), || async {
            Ok(())
        })
        .await
        .unwrap();
    sink.send(user());
    sink.send(text("after"));
    let TurnLive::Active { events } = live(&sink) else {
        panic!("steer must not reset the turn");
    };
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.as_ref(), RuntimeEvent::UserMessageStart { .. }))
            .count(),
        2
    );
    assert_eq!(
        sink.turn
            .state
            .lock()
            .unwrap()
            .projection
            .snapshot()
            .base_size,
        Some(3)
    );
}

#[tokio::test]
async fn retry_after_output_and_retrying_compaction_invalidate_a_recorded_turn() {
    let file = Jsonl::new(b"{}\n");
    for (preceding, event) in [
        (
            Some(text("partial output before error")),
            RuntimeEvent::AutoRetryStart {
                generation: 1,
                attempt: 1,
                max_attempts: 3,
                delay_ms: 10,
                error_message: "retry".to_owned(),
            },
        ),
        (
            None,
            RuntimeEvent::CompactionEnd {
                generation: 1,
                reason: "auto".to_owned(),
                result: None,
                aborted: false,
                will_retry: true,
                error_message: None,
            },
        ),
    ] {
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        sink.send(RuntimeEvent::AssistantMessageStart { generation: 1 });
        if let Some(preceding) = preceding {
            sink.send(preceding);
        }
        sink.send(event);
        assert_eq!(live(&sink), TurnLive::Truncated);
        sink.send(settled());
        assert_eq!(live(&sink), TurnLive::Idle);
    }
}

#[tokio::test]
async fn empty_step_auto_retry_and_mid_turn_compaction_stay_active() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    agent_start(&sink);
    sink.send(user());
    sink.send(RuntimeEvent::AssistantMessageStart { generation: 1 });
    sink.send(text("step one"));
    sink.send(RuntimeEvent::AssistantTextSnapshot {
        generation: 1,
        text: "step one".to_owned(),
    });
    // Step 2 fails with 503 before emitting any content; its message_end
    // echoes the same finalized text snapshot, then Pi retries.
    sink.send(RuntimeEvent::AssistantMessageStart { generation: 1 });
    sink.send(RuntimeEvent::AssistantTextSnapshot {
        generation: 1,
        text: "step one".to_owned(),
    });
    sink.send(RuntimeEvent::AutoRetryStart {
        generation: 1,
        attempt: 1,
        max_attempts: 3,
        delay_ms: 10,
        error_message: "503".to_owned(),
    });
    assert!(matches!(live(&sink), TurnLive::Active { .. }));
    // The retry's agent_start is accepted without truncating.
    agent_start(&sink);
    assert!(matches!(live(&sink), TurnLive::Active { .. }));
    sink.send(RuntimeEvent::AssistantMessageStart { generation: 1 });
    sink.send(text(" after retry"));

    // Mid-turn compaction without will_retry keeps the projection active
    // and records the compaction marker in the live events.
    sink.send(RuntimeEvent::CompactionStart {
        generation: 1,
        reason: "threshold".to_owned(),
    });
    let compaction_end = RuntimeEvent::CompactionEnd {
        generation: 1,
        reason: "threshold".to_owned(),
        result: Some(json!({ "summary": "compacted", "tokensBefore": 2000 })),
        aborted: false,
        will_retry: false,
        error_message: None,
    };
    sink.send(compaction_end.clone());
    match live(&sink) {
        TurnLive::Active { events } => {
            assert!(events.iter().any(|event| event.as_ref() == &compaction_end));
        }
        other => panic!("expected active projection after compaction, got {other:?}"),
    }
    sink.send(settled());
    assert_eq!(live(&sink), TurnLive::Idle);
}

#[tokio::test]
async fn failed_or_rejected_steers_do_not_authorize_a_queued_follow_up() {
    let file = Jsonl::new(b"{}\n");
    for transport_failure in [false, true] {
        let sink = sink(true);
        prepare(&sink, &file).await;
        agent_start(&sink);
        sink.send(user());
        let mut steer = start(&file, PromptMode::Steer);
        steer.id = Some("steer-2".to_owned());
        let _ = sink
            .turn
            .send_prompt(&sink.events, steer, || async {
                if transport_failure {
                    Err("write failed".to_owned())
                } else {
                    Ok(())
                }
            })
            .await;
        if !transport_failure {
            sink.send(RuntimeEvent::RpcMessage { generation: 1, message: json!({"type":"response", "command":"prompt", "id":"steer-2", "success":false}) });
        }
        assert!(matches!(live(&sink), TurnLive::Active { .. }));
        sink.send(user());
        assert_eq!(live(&sink), TurnLive::Truncated);
    }
}

#[tokio::test]
async fn remote_snapshot_is_truncated_without_reading_history() {
    let turn = SessionTurn::new(false);
    let events = RuntimeEventBus::default();
    let mut reads = 0;
    let snapshot = turn
        .snapshot_with_reader(
            &events,
            "remote-session",
            TranscriptWindow::default(),
            |_| {
                reads += 1;
                async { Ok(json!({"unexpected": true})) }
            },
        )
        .await
        .unwrap();

    assert_eq!(reads, 0);
    assert_eq!(snapshot.live, TurnLive::Truncated);
    assert_eq!(snapshot.history["history"]["events"], json!([]));
}

#[tokio::test]
async fn remote_stays_truncated_across_start_settle_and_restart() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(false);
    assert_eq!(live(&sink), TurnLive::Truncated);
    prepare(&sink, &file).await;
    for event in [
        user(),
        text("reply"),
        settled(),
        RuntimeEvent::ProcessState {
            generation: 2,
            state: PiProcessState::Starting,
        },
    ] {
        sink.send(event);
        assert_eq!(live(&sink), TurnLive::Truncated);
    }
}

#[tokio::test]
async fn settle_clears_the_turn_and_next_prompt_advances_the_base() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    agent_start(&sink);
    sink.send(user());
    sink.send(text("reply"));
    sink.send(settled());
    assert_eq!(live(&sink), TurnLive::Idle);
    assert_eq!(
        sink.turn
            .state
            .lock()
            .unwrap()
            .projection
            .snapshot()
            .base_size,
        None
    );
    std::fs::write(&file.0, b"{}\n{}\n").unwrap();
    prepare(&sink, &file).await;
    assert_eq!(
        sink.turn
            .state
            .lock()
            .unwrap()
            .projection
            .snapshot()
            .base_size,
        Some(6)
    );
    assert!(matches!(live(&sink), TurnLive::Active { .. }));
}

#[tokio::test]
async fn generation_changes_and_reattach_discard_the_old_projection() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    agent_start(&sink);
    sink.send(user());
    sink.send(text("old"));
    sink.send(RuntimeEvent::ProcessState {
        generation: 2,
        state: PiProcessState::Starting,
    });
    assert_eq!(live(&sink), TurnLive::Idle);
    sink.send(text("late old generation"));
    assert_eq!(live(&sink), TurnLive::Idle);
    let mut next = start(&file, PromptMode::Idle);
    next.generation = 2;
    sink.turn
        .send_prompt(&sink.events, next, || async { Ok(()) })
        .await
        .unwrap();
    assert!(matches!(live(&sink), TurnLive::Active { .. }));
    sink.send(RuntimeEvent::PiReattached {
        generation: 2,
        active: true,
        compacting: false,
    });
    assert_eq!(live(&sink), TurnLive::Truncated);
    sink.send(RuntimeEvent::PiReattached {
        generation: 2,
        active: false,
        compacting: true,
    });
    assert_eq!(live(&sink), TurnLive::Idle);
}

#[tokio::test]
async fn unsafe_boundaries_truncate_and_transport_failures_release_the_pending_turn() {
    let partial = Jsonl::new(b"{}");
    for path in [
        None,
        Some(partial.path()),
        Some(format!("{}.missing", partial.path())),
    ] {
        let sink = sink(true);
        let mut request = start(&partial, PromptMode::Idle);
        request.path = path;
        sink.turn
            .send_prompt(&sink.events, request, || async { Ok(()) })
            .await
            .unwrap();
        assert_eq!(live(&sink), TurnLive::Truncated);
        sink.send(settled());
        assert_eq!(live(&sink), TurnLive::Idle);
    }
    let file = Jsonl::new(b"");
    let sink = sink(true);
    assert!(
        sink.turn
            .send_prompt(&sink.events, start(&file, PromptMode::Idle), || async {
                Err("writer failed".to_owned())
            })
            .await
            .is_err()
    );
    assert_eq!(live(&sink), TurnLive::Idle);
    prepare(&sink, &file).await;
    assert_eq!(
        sink.turn
            .state
            .lock()
            .unwrap()
            .projection
            .snapshot()
            .base_size,
        Some(0)
    );
}

#[tokio::test]
async fn prompt_rejected_or_handled_without_a_turn_returns_to_idle() {
    let file = Jsonl::new(b"{}\n");
    for (success, disposition) in [(false, "rejected"), (true, "handled")] {
        let sink = sink(true);
        prepare(&sink, &file).await;
        sink.send(RuntimeEvent::RpcMessage { generation: 1, message: json!({"type":"response", "command":"prompt", "id":"prompt-1", "success":success, "data":{"disposition":disposition}}) });
        assert_eq!(live(&sink), TurnLive::Idle);
        prepare(&sink, &file).await;
        assert!(matches!(live(&sink), TurnLive::Active { .. }));
    }
}

#[tokio::test]
async fn projected_events_leave_host_and_web_payload_bytes_unchanged() {
    let file = Jsonl::new(b"{}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    let reference = RuntimeEventBus::default();
    let limits = EventQueueLimits {
        max_events: 32,
        max_bytes: 256 * 1024,
    };
    let mut wired_stream = sink.events.subscribe_events(limits);
    let mut reference_stream = reference.subscribe_events(limits);
    let mut wired_web = sink.events.subscribe_web();
    let mut reference_web = reference.subscribe_web();
    for event in [
        user(),
        text("a"),
        text("b"),
        RuntimeEvent::AssistantThinkingStart { generation: 1 },
        RuntimeEvent::AssistantThinkingDelta {
            generation: 1,
            delta: "think".to_owned(),
        },
        RuntimeEvent::AssistantThinkingEnd { generation: 1 },
        settled(),
    ] {
        sink.send(event.clone());
        let wired = wired_web.try_recv().unwrap();
        let mut envelope =
            RuntimeEventEnvelope::session("session".to_owned(), "project".to_owned(), event);
        envelope.timestamp_ms = wired.event.timestamp_ms;
        reference.send(envelope);
        assert_eq!(
            serde_json::to_vec(wired.as_ref()).unwrap(),
            serde_json::to_vec(reference_web.try_recv().unwrap().as_ref()).unwrap()
        );
    }
    let Some(EventBatch::Events(wired_events)) = wired_stream.try_next_batch(32) else {
        panic!("expected wired stream events");
    };
    let Some(EventBatch::Events(reference_events)) = reference_stream.try_next_batch(32) else {
        panic!("expected reference stream events");
    };
    assert_eq!(
        serde_json::to_vec(&wired_events).unwrap(),
        serde_json::to_vec(&reference_events).unwrap()
    );
    assert_eq!(wired_events.len(), 7);
}

#[tokio::test]
async fn message_ends_and_tool_execution_keep_the_turn_active_until_agent_settled() {
    #[derive(Debug, Default, PartialEq)]
    struct Transcript(Vec<Value>);

    impl Transcript {
        fn assistant(&mut self) -> &mut Value {
            if self
                .0
                .last()
                .is_none_or(|message| message["role"] != "assistant")
            {
                self.0
                    .push(json!({"role":"assistant", "blocks":[], "complete":false}));
            }
            self.0.last_mut().unwrap()
        }

        fn apply(&mut self, event: &Value) {
            match event["type"].as_str().unwrap() {
                "user_message_start" => {
                    self.0.push(json!({"role":"user", "text":event["text"]}));
                }
                "assistant_message_start" => {
                    self.assistant();
                }
                "assistant_text_delta" => {
                    let delta = event["delta"].as_str().unwrap();
                    let blocks = self.assistant()["blocks"].as_array_mut().unwrap();
                    if let Some(block) = blocks.last_mut().filter(|block| block["type"] == "text") {
                        block["text"] =
                            json!(format!("{}{}", block["text"].as_str().unwrap(), delta));
                    } else {
                        blocks.push(json!({"type":"text", "text":delta}));
                    }
                }
                "assistant_text_snapshot" => {
                    let text: String = self.assistant()["blocks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|block| block["type"] == "text")
                        .map(|block| block["text"].as_str().unwrap())
                        .collect();
                    assert_eq!(event["text"], text);
                }
                "tool_execution_start" => {
                    self.assistant()["blocks"].as_array_mut().unwrap().push(json!({
                        "type":"tool", "toolCallId":event["toolCallId"], "toolName":event["toolName"],
                        "args":event["args"], "result":null, "isError":false,
                    }));
                }
                "tool_execution_update" | "tool_execution_end" => {
                    let block = self.assistant()["blocks"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|block| {
                            block["type"] == "tool" && block["toolCallId"] == event["toolCallId"]
                        })
                        .unwrap();
                    if event["type"] == "tool_execution_update" {
                        block["result"] = event["partialResult"].clone();
                    } else {
                        block["result"] = event["result"].clone();
                        block["isError"] = event["isError"].clone();
                    }
                }
                "assistant_message_end" | "assistant_turn_end" => {
                    let message = self.assistant();
                    message["complete"] = json!(true);
                    message["stopReason"] = event["stopReason"].clone();
                    message["errorMessage"] = event["errorMessage"].clone();
                    message["usage"] = event["usage"].clone();
                }
                other => panic!("unexpected transcript event: {other}"),
            }
        }
    }

    let file = Jsonl::new(b"{\"type\":\"session\",\"version\":3,\"id\":\"test\"}\n");
    let sink = sink(true);
    prepare(&sink, &file).await;
    agent_start(&sink);
    let mut adapter = crate::pi_events::PiEventAdapter::default();
    let mut published = Vec::new();
    let mut assistant_message_ends = 0;
    let mut publish = |raw: Value| {
        if raw["type"] == "message_end" && raw["message"]["role"] == "assistant" {
            assistant_message_ends += 1;
        }
        for event in adapter.adapt(1, &raw) {
            assert_eq!(
                matches!(event, RuntimeEvent::AssistantMessageEnd { .. }),
                raw["type"] == "agent_settled"
            );
            sink.send(event.clone());
            published.push(event);
            if raw["type"] != "agent_settled" {
                assert!(matches!(live(&sink), TurnLive::Active { .. }), "{raw}");
            }
        }
        if raw["type"] == "agent_settled" {
            assert_eq!(live(&sink), TurnLive::Idle);
        } else {
            assert!(matches!(live(&sink), TurnLive::Active { .. }), "{raw}");
        }
    };
    let persist = |id: &str, parent: Option<&str>, message: &Value| {
        let entry = json!({"type":"message", "id":id, "parentId":parent, "message":message});
        writeln!(
            OpenOptions::new().append(true).open(&file.0).unwrap(),
            "{entry}"
        )
        .unwrap();
    };

    let user = json!({"role":"user", "content":[{"type":"text", "text":"List the files, then summarize."}]});
    publish(json!({"type":"message_start", "message":user}));
    publish(json!({"type":"message_end", "message":user}));
    persist("user", None, &user);

    publish(json!({"type":"message_start", "message":{"role":"assistant"}}));
    publish(
        json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta", "delta":"Listing files."}}),
    );
    let first = json!({"role":"assistant", "content":[
        {"type":"text", "text":"Listing files."},
        {"type":"toolCall", "id":"call-1", "name":"bash", "arguments":{"command":"ls"}},
    ], "stopReason":"toolUse"});
    publish(json!({"type":"message_end", "message":first}));
    persist("assistant-1", Some("user"), &first);

    publish(
        json!({"type":"tool_execution_start", "toolCallId":"call-1", "toolName":"bash", "args":{"command":"ls"}}),
    );
    publish(
        json!({"type":"tool_execution_update", "toolCallId":"call-1", "toolName":"bash", "args":{"command":"ls"}, "partialResult":{"content":[{"type":"text", "text":"a.txt\n"}]}}),
    );
    let result = json!({"content":[{"type":"text", "text":"a.txt\nb.txt\n"}]});
    publish(
        json!({"type":"tool_execution_end", "toolCallId":"call-1", "toolName":"bash", "result":result, "isError":false}),
    );
    let tool = json!({"role":"toolResult", "toolCallId":"call-1", "toolName":"bash", "content":result["content"], "isError":false});
    publish(json!({"type":"message_end", "message":tool}));
    persist("tool", Some("assistant-1"), &tool);

    publish(json!({"type":"message_start", "message":{"role":"assistant"}}));
    publish(
        json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta", "delta":"There are two files."}}),
    );
    let second = json!({"role":"assistant", "content":[{"type":"text", "text":"There are two files."}], "stopReason":"stop"});
    publish(json!({"type":"message_end", "message":second}));
    persist("assistant-2", Some("tool"), &second);

    let TurnLive::Active { events } = live(&sink) else {
        panic!("second message_end settled the turn");
    };
    let mut projected = Transcript::default();
    for event in events.iter() {
        projected.apply(&serde_json::to_value(&**event).unwrap());
    }
    publish(json!({"type":"agent_settled"}));
    assert_eq!(assistant_message_ends, 2);
    let mut raw = Transcript::default();
    for event in &published {
        raw.apply(&serde_json::to_value(event).unwrap());
    }
    projected.apply(&serde_json::to_value(published.last().unwrap()).unwrap());
    assert_eq!(projected, raw);

    let snapshot =
        crate::session_history::full_history_snapshot_for_test(&std::fs::read(&file.0).unwrap());
    let mut history = Transcript::default();
    for event in snapshot["history"]["events"].as_array().unwrap() {
        history.apply(event);
    }
    assert_eq!(history, raw);
    assert_eq!(history.0.len(), 2);
    assert_eq!(history.0[1]["blocks"].as_array().unwrap().len(), 3);
    assert!(
        sink.turn
            .state
            .lock()
            .unwrap()
            .projection
            .snapshot()
            .base_size
            .is_none()
    );
}
