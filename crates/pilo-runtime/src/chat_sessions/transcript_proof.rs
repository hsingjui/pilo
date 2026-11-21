use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::*;
use crate::{
    Runtime,
    chat_sessions::{ChatProcess, event_sink::ChatEventSink},
    events::{EventBatch, EventQueueLimits, EventStream, RuntimeEventSink, SequencedRuntimeEvent},
    host_events::RecordingEvents,
    host_paths::HostPaths,
    pi_events::PiEventAdapter,
};

struct Fixture {
    runtime: Runtime,
    sink: ChatEventSink,
    directory: PathBuf,
    path: PathBuf,
    adapter: PiEventAdapter,
    parent: Option<String>,
    stream: EventStream,
}

impl Fixture {
    async fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("pilo-transcript-{}", unique_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.jsonl");
        let header = json!({"type":"session", "version":3, "id":unique_id(), "timestamp":"2026-01-01T00:00:00.000Z", "cwd":directory.to_str().unwrap()});
        std::fs::write(&path, format!("{header}\n")).unwrap();
        let runtime = Runtime::new(
            HostPaths::for_test(directory.join("data")),
            Arc::new(RecordingEvents::default()),
        );
        let mut sink = super::tests::sink(true);
        sink.events = runtime.events.clone();
        *sink.session_path.lock().unwrap() = Some(path.to_str().unwrap().to_owned());
        let process = Arc::new(ChatProcess {
            events: sink.events.clone(),
            turn: sink.turn.clone(),
            project_id: "project".to_owned(),
            no_session: false,
            extensions: Vec::new(),
            disable_builtin_tools: false,
            disable_extension_discovery: true,
            disable_context_files: true,
            session: tokio::sync::Mutex::new(Default::default()),
            session_path: sink.session_path.clone(),
            control_reply: sink.control_reply.clone(),
            initialization_stderr: sink.initialization_stderr.clone(),
            prepared: AtomicBool::new(true),
            initialized: AtomicBool::new(true),
            active_turn: sink.active_turn.clone(),
            compacting: sink.compacting.clone(),
            pending_prompt_id: sink.pending_prompt_id.clone(),
            closed: sink.closed.clone(),
            last_used: AtomicU64::new(0),
        });
        runtime
            .chat_sessions
            .registry
            .lock()
            .await
            .processes
            .insert("session".to_owned(), process);
        let stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 20000,
            max_bytes: 64 * 1024 * 1024,
        });
        Self {
            runtime,
            sink,
            directory,
            path,
            adapter: PiEventAdapter::default(),
            parent: None,
            stream,
        }
    }

    async fn prompt(&self, mode: PromptMode, id: &str) {
        self.sink
            .turn
            .send_prompt(
                &self.sink.events,
                PromptStart {
                    generation: 1,
                    path: Some(self.path.to_str().unwrap().to_owned()),
                    id: Some(id.to_owned()),
                    mode,
                },
                || async { Ok(()) },
            )
            .await
            .unwrap();
    }

    fn publish(&mut self, raw: Value) {
        if raw["type"] == "agent_start" {
            self.sink.turn.agent_start(&self.sink.events, 1);
        }
        for event in self.adapter.adapt(1, &raw) {
            self.sink.send(event);
        }
    }

    fn persist(&mut self, message: Value) {
        let id = unique_id();
        let entry = json!({"type":"message", "id":id, "parentId":self.parent, "timestamp":"2026-01-01T00:00:01.000Z", "message":message});
        writeln!(
            OpenOptions::new().append(true).open(&self.path).unwrap(),
            "{entry}"
        )
        .unwrap();
        self.parent = Some(id);
    }

    fn end_message(&mut self, message: Value) {
        self.publish(json!({"type":"message_end", "message":message}));
        self.persist(message);
    }

    async fn snapshot(&self) -> TranscriptSnapshot {
        self.runtime
            .chat_transcript_snapshot("session", TranscriptWindow::default())
            .await
            .unwrap()
    }

    fn events(&mut self) -> Vec<Arc<SequencedRuntimeEvent>> {
        let mut events = Vec::new();
        while let Some(batch) = self.stream.try_next_batch(10000) {
            match batch {
                EventBatch::Events(batch) => events.extend(batch),
                other => panic!("lost proof events: {other:?}"),
            }
        }
        events
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn unique_id() -> String {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Default, Debug, PartialEq, Serialize, Deserialize)]
struct Document {
    messages: Vec<Message>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Message {
    role: String,
    blocks: Vec<Block>,
    stop_reason: Option<Value>,
    error_message: Option<Value>,
    usage: Option<Value>,
    complete: bool,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum Block {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        running: bool,
    },
    Tool {
        id: String,
        name: String,
        args: Value,
        result: Option<Value>,
        error: bool,
    },
}

impl Document {
    fn assistant(&mut self) -> &mut Message {
        if self
            .messages
            .last()
            .is_none_or(|message| message.role != "assistant")
        {
            self.messages.push(Message {
                role: "assistant".to_owned(),
                blocks: Vec::new(),
                stop_reason: None,
                error_message: None,
                usage: None,
                complete: false,
            });
        }
        self.messages.last_mut().unwrap()
    }

    fn delta(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let blocks = &mut self.assistant().blocks;
        if let Some(Block::Text { text }) = blocks.last_mut() {
            text.push_str(delta);
        } else {
            blocks.push(Block::Text {
                text: delta.to_owned(),
            });
        }
    }

    fn apply(&mut self, event: &Value) {
        let string = |field: &str| event[field].as_str().unwrap_or("").to_owned();
        match event["type"].as_str().unwrap() {
            "user_message_start" => self.messages.push(Message {
                role: "user".to_owned(),
                blocks: vec![Block::Text {
                    text: string("text"),
                }],
                stop_reason: None,
                error_message: None,
                usage: None,
                complete: true,
            }),
            "assistant_message_start" => {
                self.assistant();
            }
            "assistant_text_delta" => self.delta(&string("delta")),
            "assistant_text_snapshot" => {
                let current: String = self
                    .assistant()
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        Block::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                let text = string("text");
                if let Some(delta) = text.strip_prefix(&current) {
                    self.delta(delta);
                } else {
                    let indices: Vec<usize> = self
                        .assistant()
                        .blocks
                        .iter()
                        .enumerate()
                        .filter_map(|(i, b)| matches!(b, Block::Text { .. }).then_some(i))
                        .collect();
                    let mut offset = 0;
                    for (position, index) in indices.iter().enumerate() {
                        let Block::Text { text: old } = &self.assistant().blocks[*index] else {
                            unreachable!()
                        };
                        let end = if position + 1 == indices.len() {
                            text.len()
                        } else {
                            offset + old.len()
                        };
                        let Some(next) = text.get(offset..end) else {
                            return;
                        };
                        if position + 1 != indices.len() && next != old {
                            return;
                        }
                        self.assistant().blocks[*index] = Block::Text {
                            text: next.to_owned(),
                        };
                        offset = end;
                    }
                }
            }
            "assistant_thinking_start" => {
                let blocks = &mut self.assistant().blocks;
                if !matches!(blocks.last(), Some(Block::Thinking { running: true, .. })) {
                    blocks.push(Block::Thinking {
                        text: String::new(),
                        running: true,
                    });
                }
            }
            "assistant_thinking_delta" => {
                let blocks = &mut self.assistant().blocks;
                if let Some(Block::Thinking { text, .. }) = blocks
                    .iter_mut()
                    .rev()
                    .find(|b| matches!(b, Block::Thinking { running: true, .. }))
                {
                    text.push_str(&string("delta"));
                } else {
                    blocks.push(Block::Thinking {
                        text: string("delta"),
                        running: true,
                    });
                }
            }
            "assistant_thinking_end" => {
                if let Some(Block::Thinking { running, .. }) = self
                    .assistant()
                    .blocks
                    .iter_mut()
                    .rev()
                    .find(|b| matches!(b, Block::Thinking { running: true, .. }))
                {
                    *running = false;
                }
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                let id = string("toolCallId");
                let blocks = &mut self.assistant().blocks;
                let index = match blocks
                    .iter()
                    .position(|block| matches!(block,Block::Tool{id:existing,..} if *existing==id))
                {
                    Some(index) => index,
                    None => {
                        blocks.push(Block::Tool {
                            id,
                            name: string("toolName"),
                            args: event["args"].clone(),
                            result: None,
                            error: false,
                        });
                        blocks.len() - 1
                    }
                };
                let Block::Tool {
                    args,
                    result,
                    error,
                    ..
                } = &mut blocks[index]
                else {
                    unreachable!()
                };
                if event["type"] == "tool_execution_start" {
                    *args = event["args"].clone();
                }
                if event["type"] == "tool_execution_end" {
                    *result = Some(event["result"]["content"].clone());
                    *error = event["isError"] == true;
                }
            }
            "assistant_turn_end" | "assistant_message_end" => {
                let message = self.assistant();
                message.complete = true;
                message.stop_reason = event.get("stopReason").filter(|v| !v.is_null()).cloned();
                message.error_message = event.get("errorMessage").filter(|v| !v.is_null()).cloned();
                message.usage = event.get("usage").filter(|v| !v.is_null()).cloned();
                for block in &mut message.blocks {
                    if let Block::Thinking { running, .. } = block {
                        *running = false;
                    }
                }
            }
            _ => {}
        }
    }

    fn history(history: &Value) -> Self {
        let mut document = Self::default();
        for event in history["history"]["events"].as_array().unwrap() {
            document.apply(event);
        }
        document
    }
}

fn replay(snapshot: &TranscriptSnapshot, later: &[Arc<SequencedRuntimeEvent>]) -> Document {
    assert!(!matches!(snapshot.live, TurnLive::Truncated));
    let mut document = Document::history(&snapshot.history);
    if let TurnLive::Active { events } = &snapshot.live {
        for event in events.iter() {
            document.apply(&serde_json::to_value(&**event).unwrap());
        }
    }
    for event in later
        .iter()
        .filter(|event| event.sequence > snapshot.event_sequence)
    {
        if event.event.session_key.as_deref() == Some(&snapshot.session_key) {
            document.apply(&serde_json::to_value(&event.event.event).unwrap());
        }
    }
    document
}

fn assistant(text: &str, tool: bool) -> Value {
    let mut content = vec![json!({"type":"text","text":text})];
    if tool {
        content.push(
            json!({"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"ls"}}),
        );
    }
    json!({"role":"assistant", "content":content, "stopReason":if tool {"toolUse"} else {"stop"}})
}

#[tokio::test]
async fn fake_pi_persists_after_publication_and_every_cut_replays_exactly() {
    let mut fixture = Fixture::new().await;
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    let mut snapshots = vec![("right_after_prompt", fixture.snapshot().await)];
    fixture.publish(json!({"type":"agent_start"}));
    let user = json!({"role":"user","content":[{"type":"text","text":"list files"}]});
    fixture.publish(json!({"type":"message_start","message":user}));
    fixture.end_message(user);
    fixture.publish(json!({"type":"message_start","message":{"role":"assistant"}}));
    fixture.publish(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Listing "}}));
    snapshots.push(("mid_text", fixture.snapshot().await));
    fixture.publish(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"files."}}));
    fixture.end_message(assistant("Listing files.", true));
    fixture.publish(json!({"type":"tool_execution_start","toolCallId":"call-1","toolName":"bash","args":{"command":"ls"}}));
    snapshots.push(("mid_tool", fixture.snapshot().await));
    let result = json!({"content":[{"type":"text","text":"a.txt\nb.txt\n"}]});
    fixture.publish(json!({"type":"tool_execution_end","toolCallId":"call-1","toolName":"bash","result":result,"isError":false}));
    fixture.end_message(json!({"role":"toolResult","toolCallId":"call-1","toolName":"bash","content":result["content"],"isError":false}));
    fixture.publish(json!({"type":"message_start","message":{"role":"assistant"}}));
    fixture.publish(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Two files."}}));
    fixture.end_message(assistant("Two files.", false));
    snapshots.push(("turn_ending", fixture.snapshot().await));
    fixture.publish(json!({"type":"agent_settled"}));
    snapshots.push(("idle", fixture.snapshot().await));
    let expected = Document::history(&fixture.snapshot().await.history);
    let later = fixture.events();
    assert_eq!(expected.messages.len(), 2);
    for (point, snapshot) in &snapshots {
        assert_eq!(replay(snapshot, &later), expected, "{point}");
    }
    let wire = serde_json::to_value(&snapshots[0].1).unwrap();
    assert!(wire.get("eventSequence").is_some());
    assert!(wire.get("sessionKey").is_some());
    assert_eq!(wire["live"]["type"], "active");
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn queued_follow_up_is_truncated_until_settle() {
    let mut fixture = Fixture::new().await;
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    fixture.publish(json!({"type":"agent_start"}));
    fixture.publish(json!({"type":"message_start","message":{"role":"user","content":"first"}}));
    fixture.prompt(PromptMode::Queued, "pilo-follow-up").await;
    fixture
        .publish(json!({"type":"message_start","message":{"role":"user","content":"follow-up"}}));
    assert_eq!(fixture.snapshot().await.live, TurnLive::Truncated);
    fixture.publish(json!({"type":"agent_settled"}));
    assert_eq!(fixture.snapshot().await.live, TurnLive::Idle);
    fixture.runtime.shutdown().await;
}

fn seed_large_history(fixture: &Fixture) -> Vec<u8> {
    let mut bytes = std::fs::read(&fixture.path).unwrap();
    bytes.extend_from_slice(b"{\"type\":\"message\",\"id\":\"seed\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"original\"}}\n");
    let padding = format!("{}\n", json!({"type":"custom", "data":"x".repeat(1024)}));
    for _ in 0..128 {
        bytes.extend_from_slice(padding.as_bytes());
    }
    std::fs::write(&fixture.path, &bytes).unwrap();
    bytes
}

async fn assert_invalidated_tail(change: &str) {
    let fixture = Fixture::new().await;
    let mut bytes = seed_large_history(&fixture);
    let mtime = std::fs::metadata(&fixture.path)
        .unwrap()
        .modified()
        .unwrap();
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    match change {
        "newline" => {
            *bytes.last_mut().unwrap() = b' ';
            bytes.extend_from_slice(b"{}\n");
        }
        "shrink" => {
            bytes.truncate(bytes.len() - 1);
        }
        "tail" => {
            let i = bytes.len() - 20;
            assert_eq!(bytes[i], b'x');
            bytes[i] = b'y';
            bytes.extend_from_slice(b"{}\n");
        }
        "identity" => {}
        _ => unreachable!(),
    }
    if change == "identity" {
        let replacement = fixture.directory.join("replacement");
        std::fs::write(&replacement, &bytes).unwrap();
        std::fs::File::open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        std::fs::rename(replacement, &fixture.path).unwrap();
    } else {
        std::fs::write(&fixture.path, &bytes).unwrap();
    }
    assert_eq!(
        fixture.snapshot().await.live,
        TurnLive::Truncated,
        "{change}"
    );
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn tail_hash_mismatch_with_append_is_truncated() {
    assert_invalidated_tail("tail").await;
}

#[tokio::test]
async fn shrunk_prefix_is_truncated() {
    assert_invalidated_tail("shrink").await;
}

#[tokio::test]
async fn identity_change_with_identical_bytes_and_mtime_is_truncated() {
    assert_invalidated_tail("identity").await;
}

#[tokio::test]
async fn non_newline_at_base_is_truncated_even_if_file_ends_in_newline() {
    assert_invalidated_tail("newline").await;
}

#[tokio::test]
async fn bounded_tail_seal_cannot_detect_earlier_rewrites_with_append_or_restored_mtime() {
    for append in [false, true] {
        let fixture = Fixture::new().await;
        let mut bytes = seed_large_history(&fixture);
        let mtime = std::fs::metadata(&fixture.path)
            .unwrap()
            .modified()
            .unwrap();
        fixture.prompt(PromptMode::Idle, "pilo-main").await;
        let offset = bytes
            .windows(8)
            .position(|bytes| bytes == b"original")
            .unwrap();
        bytes[offset..offset + 8].copy_from_slice(b"mutated!");
        if append {
            bytes.extend_from_slice(b"{}\n");
        }
        std::fs::write(&fixture.path, &bytes).unwrap();
        if !append {
            std::fs::File::open(&fixture.path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(mtime))
                .unwrap();
        }
        let snapshot = fixture.snapshot().await;
        assert!(matches!(snapshot.live, TurnLive::Active { .. }));
        assert!(snapshot.history.to_string().contains("mutated!"));
        fixture.runtime.shutdown().await;
    }
}

#[tokio::test]
async fn mtime_change_without_append_is_conservatively_truncated() {
    let fixture = Fixture::new().await;
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    let mtime = std::fs::metadata(&fixture.path)
        .unwrap()
        .modified()
        .unwrap();
    std::fs::File::open(&fixture.path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime + Duration::from_secs(1)))
        .unwrap();
    assert_eq!(fixture.snapshot().await.live, TurnLive::Truncated);
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn publish_during_active_read_is_above_the_cut_and_idle_read_retries() {
    let mut fixture = Fixture::new().await;
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    let snapshot = fixture
        .sink
        .turn
        .snapshot_with_reader(
            &fixture.sink.events,
            "session",
            TranscriptWindow::default(),
            |base| {
                fixture.sink.send(RuntimeEvent::UserMessageStart {
                    generation: 1,
                    text: "during read".to_owned(),
                });
                read_transcript_history(
                    fixture.path.to_str().unwrap().to_owned(),
                    base,
                    TranscriptWindow::default(),
                    &fixture.runtime.session_history_cache,
                    "project",
                )
            },
        )
        .await
        .unwrap();
    assert!(snapshot.event_sequence < fixture.sink.events.latest_sequence());
    let TurnLive::Active { events } = &snapshot.live else {
        panic!("expected recorded turn")
    };
    assert!(events.is_empty());
    fixture.persist(json!({"role":"user","content":"during read"}));
    fixture.publish(json!({"type":"message_start","message":{"role":"assistant"}}));
    fixture.publish(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"read complete"}}));
    fixture.end_message(assistant("read complete", false));
    fixture.publish(json!({"type":"agent_settled"}));
    let final_history = Document::history(&fixture.snapshot().await.history);
    assert_eq!(replay(&snapshot, &fixture.events()), final_history);
    let mut calls = 0;
    let snapshot = fixture
        .sink
        .turn
        .snapshot_with_reader(
            &fixture.sink.events,
            "session",
            TranscriptWindow::default(),
            |base| {
                calls += 1;
                if calls == 1 {
                    fixture.sink.send(RuntimeEvent::RuntimeLog {
                        generation: 1,
                        stream: crate::events::RuntimeLogStream::Stderr,
                        message: "during idle read".to_owned(),
                    });
                }
                read_transcript_history(
                    fixture.path.to_str().unwrap().to_owned(),
                    base,
                    TranscriptWindow::default(),
                    &fixture.runtime.session_history_cache,
                    "project",
                )
            },
        )
        .await
        .unwrap();
    assert_eq!(calls, 2);
    assert_eq!(snapshot.live, TurnLive::Idle);
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn empty_history_and_windows_use_the_existing_history_contract() {
    let mut fixture = Fixture::new().await;
    std::fs::write(&fixture.path, b"").unwrap();
    let empty = fixture.snapshot().await;
    assert_eq!(empty.live, TurnLive::Idle);
    assert!(
        empty.history["history"]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    fixture.persist(json!({"role":"user","content":"question"}));
    fixture.persist(assistant("answer", false));
    let full = fixture.snapshot().await;
    let expected = crate::session_history::full_history_snapshot_for_test(
        &std::fs::read(&fixture.path).unwrap(),
    );
    assert_eq!(full.history["history"], expected["history"]);
    let window = fixture
        .runtime
        .chat_transcript_snapshot(
            "session",
            TranscriptWindow {
                start_message: Some(1),
                message_limit: Some(1),
                include_message_index: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(window.history["history"]["windowStartMessage"], 1);
    assert_eq!(window.history["history"]["windowMessageCount"], 1);
    assert_eq!(window.history["history"]["totalMessages"], 2);
    assert_eq!(
        window.history["history"]["messageIndex"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(window.history["fingerprint"], full.history["fingerprint"]);
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn unknown_session_and_unavailable_file_have_explicit_results() {
    let fixture = Fixture::new().await;
    assert!(
        fixture
            .runtime
            .chat_transcript_snapshot("missing", TranscriptWindow::default())
            .await
            .unwrap_err()
            .contains("not running")
    );
    std::fs::remove_file(&fixture.path).unwrap();
    assert_eq!(fixture.snapshot().await.live, TurnLive::Truncated);
    fixture.runtime.shutdown().await;
}

#[tokio::test]
#[ignore = "requires installed Pi and provisioned relay/deepseek-flash; writes PI_TRANSCRIPT_EVIDENCE"]
async fn real_pi_transcript_snapshot_proof() {
    let version = tokio::process::Command::new("pi")
        .arg("--version")
        .output()
        .await
        .unwrap();
    assert!(version.status.success());
    let version = String::from_utf8(version.stdout).unwrap().trim().to_owned();
    assert_eq!(version, "1.5.2");
    let mut fixture = Fixture::new().await;
    std::fs::write(fixture.directory.join("alpha.txt"), "alpha\n").unwrap();
    std::fs::write(fixture.directory.join("beta.txt"), "beta\n").unwrap();
    let mut child = tokio::process::Command::new("pi")
        .args([
            "--mode",
            "rpc",
            "--provider",
            "relay",
            "--model",
            "deepseek-flash",
            "--thinking",
            "off",
            "--tools",
            "bash",
            "--no-extensions",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--session",
            fixture.path.to_str().unwrap(),
        ])
        .current_dir(&fixture.directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    input
        .write_all(b"{\"type\":\"get_state\",\"id\":\"proof-init\"}\n")
        .await
        .unwrap();
    loop {
        let line = tokio::time::timeout(Duration::from_secs(60), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let raw: Value = serde_json::from_str(&line).unwrap();
        if raw["id"] == "proof-init" {
            assert_eq!(raw["success"], true);
            assert_eq!(raw["data"]["model"]["id"], "deepseek-flash");
            assert_eq!(raw["data"]["model"]["provider"], "relay");
            break;
        }
    }
    let mut snapshots = Vec::new();
    let mut queued = false;
    let mut results = Vec::new();
    let mut captures = Vec::new();
    for scenario in 0..2 {
        let id = format!("pilo-proof-{scenario}");
        let prompt = "First say a short introductory sentence, then use bash to run exactly: printf 'tool-start\\n'; sleep 2; ls -1 alpha.txt beta.txt; printf 'tool-end\\n'. Then summarize both file names in two sentences. Do not use other tools.";
        fixture.prompt(PromptMode::Idle, &id).await;
        input
            .write_all(
                format!("{}\n", json!({"type":"prompt","id":id,"message":prompt})).as_bytes(),
            )
            .await
            .unwrap();
        if scenario == 0 {
            snapshots.push(("right_after_prompt", fixture.snapshot().await));
        }
        let mut text = false;
        let mut tool = false;
        let mut ending = false;
        loop {
            let line = tokio::time::timeout(Duration::from_secs(180), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .expect("Pi closed before settle");
            let raw: Value = serde_json::from_str(&line).unwrap();
            fixture.publish(raw.clone());
            if scenario == 0
                && !text
                && raw.pointer("/assistantMessageEvent/type") == Some(&json!("text_delta"))
            {
                snapshots.push(("mid_text", fixture.snapshot().await));
                text = true;
            }
            if raw["type"] == "tool_execution_start" && !tool {
                tool = true;
                if scenario == 0 {
                    snapshots.push(("mid_tool", fixture.snapshot().await));
                } else {
                    fixture
                        .prompt(PromptMode::Queued, "pilo-proof-queued")
                        .await;
                    input.write_all(format!("{}\n",json!({"type":"prompt","id":"pilo-proof-queued","message":"Reply with exactly QUEUED-FOLLOW-UP-DONE, without tools.","streamingBehavior":"followUp"})).as_bytes()).await.unwrap();
                }
            }
            if scenario == 1
                && raw["type"] == "message_start"
                && raw["message"]["role"] == "user"
                && !snapshots
                    .iter()
                    .any(|(name, _)| *name == "queued_follow_up")
            {
                let content = raw["message"]["content"].to_string();
                if content.contains("QUEUED-FOLLOW-UP-DONE") {
                    let snapshot = fixture.snapshot().await;
                    assert_eq!(snapshot.live, TurnLive::Truncated);
                    snapshots.push(("queued_follow_up", snapshot));
                    queued = true;
                }
            }
            if scenario == 0 && raw["type"] == "agent_end" && !ending {
                snapshots.push(("turn_ending", fixture.snapshot().await));
                ending = true;
            }
            if raw["type"] == "agent_settled" {
                break;
            }
        }
        assert!(tool, "real Pi did not make a tool call");
        if scenario == 0 {
            assert!(text && ending);
            snapshots.push(("idle", fixture.snapshot().await));
        }
        let settled = fixture.snapshot().await;
        assert_eq!(settled.live, TurnLive::Idle);
        let expected = Document::history(&settled.history);
        let events = fixture.events();
        for (point, snapshot) in snapshots.drain(..) {
            let truncated = matches!(snapshot.live, TurnLive::Truncated);
            let actual = if truncated {
                assert_eq!(point, "queued_follow_up");
                Document::history(&fixture.snapshot().await.history)
            } else {
                replay(&snapshot, &events)
            };
            assert_eq!(actual, expected, "real Pi: {point}");
            results.push(json!({"scenario":scenario,"point":point,"eventSequence":snapshot.event_sequence,"live":if truncated {"truncated"}else if matches!(snapshot.live,TurnLive::Idle){"idle"}else{"active"},"exactReplay":!truncated,"freshHistoryResyncVerified":truncated,"matchedFinalTranscript":true}));
            captures.push(json!({"scenario":scenario,"point":point,"snapshot":snapshot,"laterEvents":events.iter().filter(|event|event.sequence>snapshot.event_sequence).collect::<Vec<_>>(),"freshHistory":settled.history,"replayedTranscript":actual,"expectedTranscript":expected}));
        }
    }
    assert!(queued, "queued follow-up was not observed");
    let final_snapshot = fixture.snapshot().await;
    assert_eq!(final_snapshot.live, TurnLive::Idle);
    let expected = Document::history(&final_snapshot.history);
    assert_eq!(results.len(), 6);
    let evidence = json!({"piVersion":version,"provider":"relay","model":"deepseek-flash","comparison":"each scenario against a fresh history load at that scenario's settle; ordered messages/text/thinking/tool names, arguments, result content, errors and completion metadata; excludes entry IDs, timestamps and transport-only tool metadata","finalMessages":expected.messages.len(),"points":results,"captures":captures,"passed":true});
    let path =
        std::env::var("PI_TRANSCRIPT_EVIDENCE").expect("set persistent evidence output path");
    std::fs::write(&path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    println!(
        "{}",
        serde_json::to_string_pretty(&evidence["points"]).unwrap()
    );
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn snapshot_during_a_turn_warms_the_boundary_projection() {
    let mut fixture = Fixture::new().await;
    fixture.persist(json!({"role":"user","content":"question"}));
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    fixture.end_message(assistant("answer", false));
    let snapshot = fixture.snapshot().await;
    assert!(matches!(snapshot.live, TurnLive::Active { .. }));
    let fingerprint = &snapshot.history["fingerprint"];
    let key = crate::session_history::cache_key("project", fixture.path.to_str().unwrap());
    let stored = fixture
        .runtime
        .session_history_cache
        .lock()
        .await
        .cached_projection_for_test(&key)
        .expect("the snapshot did not store its projection");
    assert_eq!(
        (
            fingerprint["fileSize"].as_u64().unwrap(),
            fingerprint["fileMtimeNs"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        ),
        (stored.0, stored.1)
    );
    // The stored projection is the recorded prefix, not the grown file, so a
    // page load for the same boundary serves it without another parse.
    assert!(stored.0 < std::fs::metadata(&fixture.path).unwrap().len());
    fixture.runtime.shutdown().await;
}

#[tokio::test]
async fn snapshot_at_an_earlier_boundary_keeps_live_reads_current() {
    let mut fixture = Fixture::new().await;
    fixture.persist(json!({"role":"user","content":"question"}));
    fixture.prompt(PromptMode::Idle, "pilo-main").await;
    fixture.end_message(assistant("answer", false));
    let path = fixture.path.to_str().unwrap().to_owned();
    let key = crate::session_history::cache_key("project", &path);
    // A live read caches the projection of the whole file first.
    let live = read_transcript_history(
        path.clone(),
        None,
        TranscriptWindow::default(),
        &fixture.runtime.session_history_cache,
        "project",
    )
    .await
    .unwrap();
    // The turn's snapshot replaces it with the earlier recorded boundary.
    let snapshot = fixture.snapshot().await;
    let stored = fixture
        .runtime
        .session_history_cache
        .lock()
        .await
        .cached_projection_for_test(&key)
        .unwrap();
    assert_eq!(
        stored.0,
        snapshot.history["fingerprint"]["fileSize"]
            .as_u64()
            .unwrap()
    );
    // A boundary-less read must still return the grown file: it extends the
    // stored prefix through its checkpoint instead of serving stale content.
    let current = read_transcript_history(
        path.clone(),
        None,
        TranscriptWindow::default(),
        &fixture.runtime.session_history_cache,
        "project",
    )
    .await
    .unwrap();
    assert_eq!(current, live);
    let stored = fixture
        .runtime
        .session_history_cache
        .lock()
        .await
        .cached_projection_for_test(&key)
        .unwrap();
    assert_eq!(stored.2, 1);
    fixture.runtime.shutdown().await;
}
