//! Pure turn projection. History reads and event publication belong to the caller.

use std::sync::Arc;

use serde::Serialize;

use super::{LiveUserImage, PayloadSize, RuntimeEvent};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedUserImages {
    // User-message ordinal, unaffected by coalescing or removing assistant events.
    pub user_index: usize,
    pub images: Vec<LiveUserImage>,
}

/// Limits apply to the retained, merged list. Bytes are the sum of each event's
/// JSON size, excluding array delimiters, Arc overhead and spare allocation capacity.
#[derive(Clone, Copy, Debug)]
pub struct TurnLimits {
    pub max_events: usize,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TurnLive {
    Idle,
    Active { events: Arc<Vec<Arc<RuntimeEvent>>> },
    Truncated,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnSnapshot {
    pub base_size: Option<u64>,
    pub live: TurnLive,
}

pub struct TurnProjection {
    limits: TurnLimits,
    snapshot: TurnSnapshot,
    bytes: usize,
    event_sizes: Vec<usize>,
    user_count: usize,
    user_images: Arc<Vec<ProjectedUserImages>>,
}

impl TurnProjection {
    pub fn new(limits: TurnLimits) -> Self {
        Self {
            limits,
            snapshot: TurnSnapshot {
                base_size: None,
                live: TurnLive::Idle,
            },
            bytes: 0,
            event_sizes: Vec::new(),
            user_count: 0,
            user_images: Arc::default(),
        }
    }

    /// The caller must establish a safe, idle JSONL boundary before beginning.
    /// An overlapping begin invalidates the projection rather than losing a turn.
    pub fn begin(&mut self, base_size: u64) -> bool {
        if !matches!(self.snapshot.live, TurnLive::Idle) {
            self.truncate();
            return false;
        }
        self.snapshot.base_size = Some(base_size);
        self.snapshot.live = TurnLive::Active {
            events: Arc::new(Vec::new()),
        };
        self.event_sizes.clear();
        true
    }

    /// A constant-time snapshot; later writes use copy-on-write event storage.
    pub fn snapshot(&self) -> TurnSnapshot {
        self.snapshot.clone()
    }

    pub(crate) fn user_images(&self) -> Option<Arc<Vec<ProjectedUserImages>>> {
        (!self.user_images.is_empty()).then(|| Arc::clone(&self.user_images))
    }

    /// Only adjacent deltas of the same kind and generation merge; tool execution
    /// updates replace earlier updates for the same tool call in the current
    /// assistant segment, and tool execution ends reclaim redundant updates when
    /// a matching start already carries the arguments. Input without a recorded
    /// begin invalidates the projection rather than losing a prefix.
    pub fn push(&mut self, event: RuntimeEvent) {
        self.push_with_images(event, Vec::new());
    }

    pub(crate) fn push_with_images(&mut self, event: RuntimeEvent, images: Vec<LiveUserImage>) {
        let TurnLive::Active { events } = &mut self.snapshot.live else {
            self.truncate();
            return;
        };
        if let RuntimeEvent::ToolExecutionUpdate {
            generation,
            tool_call_id,
            ..
        } = &event
            && let Some(index) = find_segment_tool_update(events, *generation, tool_call_id)
        {
            let Some(old_bytes) = self.event_sizes.get(index).copied() else {
                self.truncate();
                return;
            };
            let Some(new_bytes) = json_size(&event) else {
                self.truncate();
                return;
            };
            let Some(next_bytes) = self
                .bytes
                .checked_sub(old_bytes)
                .and_then(|bytes| bytes.checked_add(new_bytes))
            else {
                self.truncate();
                return;
            };
            if next_bytes > self.limits.max_bytes {
                self.truncate();
                return;
            }
            Arc::make_mut(events)[index] = Arc::new(event);
            self.event_sizes[index] = new_bytes;
            self.bytes = next_bytes;
            return;
        }
        if let RuntimeEvent::ToolExecutionEnd {
            generation,
            tool_call_id,
            ..
        } = &event
            && let Some(update_index) =
                find_reclaimable_tool_update(events, *generation, tool_call_id)
        {
            let Some(old_bytes) = self.event_sizes.get(update_index).copied() else {
                self.truncate();
                return;
            };
            let Some(new_bytes) = json_size(&event) else {
                self.truncate();
                return;
            };
            let Some(next_bytes) = self
                .bytes
                .checked_sub(old_bytes)
                .and_then(|bytes| bytes.checked_add(new_bytes))
            else {
                self.truncate();
                return;
            };
            if next_bytes > self.limits.max_bytes || events.len() > self.limits.max_events {
                self.truncate();
                return;
            }
            let events = Arc::make_mut(events);
            events.remove(update_index);
            events.push(Arc::new(event));
            self.event_sizes.remove(update_index);
            self.event_sizes.push(new_bytes);
            self.bytes = next_bytes;
            return;
        }
        let incoming_delta = match (events.last().map(AsRef::as_ref), &event) {
            (
                Some(RuntimeEvent::AssistantTextDelta {
                    generation: previous,
                    ..
                }),
                RuntimeEvent::AssistantTextDelta { generation, delta },
            )
            | (
                Some(RuntimeEvent::AssistantThinkingDelta {
                    generation: previous,
                    ..
                }),
                RuntimeEvent::AssistantThinkingDelta { generation, delta },
            ) if previous == generation => Some(delta.as_str()),
            _ => None,
        };
        let user_images = (!images.is_empty()).then_some(ProjectedUserImages {
            user_index: self.user_count,
            images,
        });
        let additional_bytes = match incoming_delta {
            Some(delta) => json_size(delta).and_then(|size| size.checked_sub(2)),
            None => json_size(&event).and_then(|bytes| match &user_images {
                Some(images) => bytes.checked_add(json_size(images)?),
                None => Some(bytes),
            }),
        };
        let Some(added_bytes) = additional_bytes else {
            self.truncate();
            return;
        };
        let Some(next_bytes) = self.bytes.checked_add(added_bytes) else {
            self.truncate();
            return;
        };
        if next_bytes > self.limits.max_bytes
            || (incoming_delta.is_none() && events.len() >= self.limits.max_events)
        {
            self.truncate();
            return;
        }
        let events = Arc::make_mut(events);
        if let (Some(incoming), Some(previous)) = (incoming_delta, events.last_mut()) {
            match Arc::make_mut(previous) {
                RuntimeEvent::AssistantTextDelta { delta, .. }
                | RuntimeEvent::AssistantThinkingDelta { delta, .. } => {
                    delta.push_str(incoming);
                    if let Some(last_size) = self.event_sizes.last_mut() {
                        *last_size = last_size.saturating_add(added_bytes);
                    }
                }
                _ => {
                    self.truncate();
                    return;
                }
            }
        } else {
            if matches!(event, RuntimeEvent::UserMessageStart { .. }) {
                self.user_count += 1;
                if let Some(images) = user_images {
                    Arc::make_mut(&mut self.user_images).push(images);
                }
            }
            events.push(Arc::new(event));
            self.event_sizes.push(added_bytes);
        }
        self.bytes = next_bytes;
    }

    /// Marks an unsafe start or invalidated history boundary. Sticky until settle.
    pub fn truncate(&mut self) {
        self.snapshot.base_size = None;
        self.snapshot.live = TurnLive::Truncated;
        self.clear_retained();
    }

    pub fn settle(&mut self) {
        self.snapshot.base_size = None;
        self.snapshot.live = TurnLive::Idle;
        self.clear_retained();
    }

    fn clear_retained(&mut self) {
        self.bytes = 0;
        self.event_sizes.clear();
        self.user_count = 0;
        self.user_images = Arc::default();
    }
}

fn is_segment_boundary(event: &RuntimeEvent, generation: u64) -> bool {
    matches!(
        event,
        RuntimeEvent::UserMessageStart { .. } | RuntimeEvent::CompactionEnd { .. }
    ) || event
        .generation()
        .is_some_and(|existing| existing != generation)
}

fn find_segment_tool_update(
    events: &[Arc<RuntimeEvent>],
    generation: u64,
    tool_call_id: &str,
) -> Option<usize> {
    for (index, existing) in events.iter().enumerate().rev() {
        if is_segment_boundary(existing.as_ref(), generation) {
            break;
        }
        match existing.as_ref() {
            RuntimeEvent::ToolExecutionUpdate {
                generation: prev_gen,
                tool_call_id: prev_id,
                ..
            } if *prev_gen == generation && prev_id == tool_call_id => {
                return Some(index);
            }
            RuntimeEvent::ToolExecutionStart {
                generation: prev_gen,
                tool_call_id: prev_id,
                ..
            }
            | RuntimeEvent::ToolExecutionEnd {
                generation: prev_gen,
                tool_call_id: prev_id,
                ..
            } if *prev_gen == generation && prev_id == tool_call_id => {
                break;
            }
            _ => {}
        }
    }
    None
}

/// Finds a `ToolExecutionUpdate` in the current assistant segment that can be
/// removed when `ToolExecutionEnd` arrives without losing tool arguments.
fn find_reclaimable_tool_update(
    events: &[Arc<RuntimeEvent>],
    generation: u64,
    tool_call_id: &str,
) -> Option<usize> {
    let mut update: Option<(usize, &serde_json::Value)> = None;
    for (index, existing) in events.iter().enumerate().rev() {
        if is_segment_boundary(existing.as_ref(), generation) {
            break;
        }
        match existing.as_ref() {
            RuntimeEvent::ToolExecutionUpdate {
                generation: prev_gen,
                tool_call_id: prev_id,
                args,
                ..
            } if *prev_gen == generation && prev_id == tool_call_id && update.is_none() => {
                update = Some((index, args));
            }
            RuntimeEvent::ToolExecutionStart {
                generation: prev_gen,
                tool_call_id: prev_id,
                args,
                ..
            } if *prev_gen == generation && prev_id == tool_call_id => {
                let (update_index, update_args) = update?;
                return (args == update_args).then_some(update_index);
            }
            RuntimeEvent::ToolExecutionEnd {
                generation: prev_gen,
                tool_call_id: prev_id,
                ..
            } if *prev_gen == generation && prev_id == tool_call_id => {
                break;
            }
            _ => {}
        }
    }
    None
}

fn json_size<T: Serialize + ?Sized>(value: &T) -> Option<usize> {
    let mut size = PayloadSize::default();
    serde_json::to_writer(&mut size, value).ok()?;
    (size.0 < usize::MAX).then_some(size.0)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn projection() -> TurnProjection {
        TurnProjection::new(TurnLimits {
            max_events: 1024,
            max_bytes: 1024 * 1024,
        })
    }

    fn text(delta: &str) -> RuntimeEvent {
        RuntimeEvent::AssistantTextDelta {
            generation: 1,
            delta: delta.to_owned(),
        }
    }

    fn thinking(delta: &str) -> RuntimeEvent {
        RuntimeEvent::AssistantThinkingDelta {
            generation: 1,
            delta: delta.to_owned(),
        }
    }

    fn user(text: &str) -> RuntimeEvent {
        RuntimeEvent::UserMessageStart {
            generation: 1,
            text: text.to_owned(),
        }
    }

    fn tools() -> Vec<RuntimeEvent> {
        vec![
            RuntimeEvent::ToolExecutionStart {
                generation: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: json!({"command": "pwd"}),
            },
            RuntimeEvent::ToolExecutionUpdate {
                generation: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: json!({"command": "pwd"}),
                partial_result: json!({"content": "partial"}),
            },
            RuntimeEvent::ToolExecutionEnd {
                generation: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                result: json!({"content": "/project"}),
                is_error: false,
            },
        ]
    }

    fn retained(snapshot: &TurnSnapshot) -> &Arc<Vec<Arc<RuntimeEvent>>> {
        let TurnLive::Active { events } = &snapshot.live else {
            panic!("expected active turn: {snapshot:?}");
        };
        events
    }

    #[derive(Debug, PartialEq)]
    enum Block {
        Text(String),
        Thinking {
            text: String,
            running: bool,
        },
        Tool {
            id: String,
            payload: Value,
            running: bool,
        },
    }

    #[derive(Debug, PartialEq)]
    enum Message {
        User(String),
        Assistant { generation: u64, blocks: Vec<Block> },
    }

    #[derive(Default, Debug, PartialEq)]
    struct Transcript(Vec<Message>);

    impl Transcript {
        fn assistant(&mut self, generation: u64) -> &mut Vec<Block> {
            if !matches!(self.0.last(), Some(Message::Assistant { generation: current, .. }) if *current == generation)
            {
                self.0.push(Message::Assistant {
                    generation,
                    blocks: Vec::new(),
                });
            }
            let Message::Assistant { blocks, .. } = self.0.last_mut().unwrap() else {
                unreachable!();
            };
            blocks
        }

        fn apply(&mut self, event: &RuntimeEvent) {
            match event {
                RuntimeEvent::UserMessageStart { text, .. } => {
                    self.0.push(Message::User(text.clone()))
                }
                RuntimeEvent::AssistantMessageStart { generation } => {
                    self.assistant(*generation);
                }
                RuntimeEvent::AssistantTextDelta { generation, delta } => {
                    let blocks = self.assistant(*generation);
                    if !delta.is_empty() {
                        if let Some(Block::Text(text)) = blocks.last_mut() {
                            text.push_str(delta);
                        } else {
                            blocks.push(Block::Text(delta.clone()));
                        }
                    }
                }
                RuntimeEvent::AssistantThinkingStart { generation } => {
                    let blocks = self.assistant(*generation);
                    if !matches!(blocks.last(), Some(Block::Thinking { running: true, .. })) {
                        blocks.push(Block::Thinking {
                            text: String::new(),
                            running: true,
                        });
                    }
                }
                RuntimeEvent::AssistantThinkingDelta { generation, delta } => {
                    let blocks = self.assistant(*generation);
                    if !delta.is_empty() {
                        if let Some(Block::Thinking { text, .. }) = blocks
                            .iter_mut()
                            .rev()
                            .find(|block| matches!(block, Block::Thinking { running: true, .. }))
                        {
                            text.push_str(delta);
                        } else {
                            blocks.push(Block::Thinking {
                                text: delta.clone(),
                                running: true,
                            });
                        }
                    }
                }
                RuntimeEvent::AssistantThinkingEnd { generation } => {
                    if let Some(Block::Thinking { running, .. }) = self
                        .assistant(*generation)
                        .iter_mut()
                        .rev()
                        .find(|block| matches!(block, Block::Thinking { running: true, .. }))
                    {
                        *running = false;
                    }
                }
                RuntimeEvent::ToolExecutionStart {
                    generation,
                    tool_call_id,
                    args,
                    ..
                }
                | RuntimeEvent::ToolExecutionUpdate {
                    generation,
                    tool_call_id,
                    partial_result: args,
                    ..
                }
                | RuntimeEvent::ToolExecutionEnd {
                    generation,
                    tool_call_id,
                    result: args,
                    ..
                } => {
                    let blocks = self.assistant(*generation);
                    let next = Block::Tool {
                        id: tool_call_id.clone(),
                        payload: args.clone(),
                        running: !matches!(event, RuntimeEvent::ToolExecutionEnd { .. }),
                    };
                    if let Some(block) = blocks
                        .iter_mut()
                        .find(|block| matches!(block, Block::Tool { id, .. } if id == tool_call_id))
                    {
                        *block = next;
                    } else {
                        blocks.push(next);
                    }
                }
                _ => panic!("unsupported replay event: {event:?}"),
            }
        }
    }

    fn replay<'a>(events: impl IntoIterator<Item = &'a RuntimeEvent>) -> Transcript {
        let mut transcript = Transcript::default();
        for event in events {
            transcript.apply(event);
        }
        transcript
    }

    fn assert_replay(raw: &[RuntimeEvent]) -> TurnSnapshot {
        let mut turn = projection();
        assert!(turn.begin(100));
        for event in raw {
            turn.push(event.clone());
        }
        let snapshot = turn.snapshot();
        let events = retained(&snapshot);
        assert_eq!(
            replay(raw),
            replay(events.iter().map(AsRef::as_ref)),
            "{raw:?}"
        );
        assert_eq!(
            turn.bytes,
            events
                .iter()
                .map(|event| serde_json::to_vec(event.as_ref()).unwrap().len())
                .sum::<usize>()
        );
        snapshot
    }

    #[test]
    fn merged_replay_equals_raw_at_every_prefix() {
        let mut raw = vec![
            user("prompt"),
            RuntimeEvent::AssistantMessageStart { generation: 1 },
            text("a"),
            text("b"),
            RuntimeEvent::AssistantThinkingStart { generation: 1 },
            thinking("x"),
            thinking("y"),
            RuntimeEvent::AssistantThinkingEnd { generation: 1 },
            text("c"),
            text("d"),
        ];
        raw.extend(tools());
        raw.extend([
            text("e"),
            text("f"),
            user("steer"),
            thinking("implicit"),
            thinking(" block"),
            RuntimeEvent::AssistantThinkingEnd { generation: 1 },
        ]);
        for end in 0..=raw.len() {
            assert_replay(&raw[..end]);
        }
        assert!(retained(&assert_replay(&raw)).len() < raw.len());
    }

    #[test]
    fn replay_equivalence_includes_empty_deltas_and_block_boundaries() {
        let mut alphabet = vec![
            text("a"),
            text(""),
            thinking("b"),
            thinking(""),
            RuntimeEvent::AssistantThinkingStart { generation: 1 },
            RuntimeEvent::AssistantThinkingEnd { generation: 1 },
            RuntimeEvent::AssistantMessageStart { generation: 1 },
            user("steer"),
            RuntimeEvent::AssistantTextDelta {
                generation: 2,
                delta: "new generation".to_owned(),
            },
        ];
        alphabet.extend(tools());
        for mut code in 0..alphabet.len().pow(4) {
            let mut raw = Vec::new();
            for _ in 0..4 {
                raw.push(alphabet[code % alphabet.len()].clone());
                code /= alphabet.len();
            }
            assert_replay(&raw);
        }
    }

    #[test]
    fn merges_only_adjacent_same_kind_same_generation_deltas() {
        let raw = vec![
            text("a"),
            text("b"),
            thinking("x"),
            thinking("y"),
            RuntimeEvent::AssistantThinkingEnd { generation: 1 },
            thinking("z"),
            RuntimeEvent::AssistantTextDelta {
                generation: 2,
                delta: "c".to_owned(),
            },
            text("d"),
        ];
        let snapshot = assert_replay(&raw);
        assert_eq!(
            retained(&snapshot)
                .iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>(),
            vec![
                &text("ab"),
                &thinking("xy"),
                &raw[4],
                &raw[5],
                &raw[6],
                &raw[7]
            ]
        );
    }

    #[test]
    fn event_bound_counts_retained_events_after_merging() {
        let mut turn = TurnProjection::new(TurnLimits {
            max_events: 1,
            max_bytes: usize::MAX,
        });
        assert!(turn.begin(100));
        turn.push(text("a"));
        turn.push(text("b"));
        assert_eq!(retained(&turn.snapshot()).len(), 1);
        turn.push(thinking("x"));
        assert_eq!(turn.snapshot().live, TurnLive::Truncated);
        assert_eq!(turn.bytes, 0);
    }

    #[test]
    fn byte_bound_counts_escaped_utf8_and_merged_payloads_exactly() {
        let first = "你好\n\"";
        let second = "\\\t🙂";
        let size = serde_json::to_vec(&text(&format!("{first}{second}")))
            .unwrap()
            .len();
        for max_bytes in [size - 1, size] {
            let mut turn = TurnProjection::new(TurnLimits {
                max_events: 10,
                max_bytes,
            });
            assert!(turn.begin(0));
            turn.push(text(first));
            assert!(matches!(turn.snapshot().live, TurnLive::Active { .. }));
            turn.push(text(second));
            if max_bytes == size {
                assert_eq!(turn.bytes, size);
                assert_eq!(retained(&turn.snapshot()).len(), 1);
            } else {
                assert_eq!(turn.snapshot().live, TurnLive::Truncated);
            }
        }
    }

    #[test]
    fn oversized_events_and_zero_limits_truncate() {
        for limits in [
            TurnLimits {
                max_events: 0,
                max_bytes: usize::MAX,
            },
            TurnLimits {
                max_events: 1,
                max_bytes: 0,
            },
            TurnLimits {
                max_events: 1,
                max_bytes: serde_json::to_vec(&text("large")).unwrap().len() - 1,
            },
        ] {
            let mut turn = TurnProjection::new(limits);
            assert!(turn.begin(10));
            turn.push(text("large"));
            assert_eq!(
                turn.snapshot(),
                TurnSnapshot {
                    base_size: None,
                    live: TurnLive::Truncated
                }
            );
        }
    }

    #[test]
    fn steer_messages_remain_in_live_without_rebasing() {
        let raw = [user("prompt"), text("before"), user("steer"), text("after")];
        let snapshot = assert_replay(&raw);
        assert_eq!(snapshot.base_size, Some(100));
        assert_eq!(
            retained(&snapshot)
                .iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>(),
            raw.iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn tool_updates_coalesce_in_place_and_reclaim_on_end() {
        let mut raw = vec![
            RuntimeEvent::ToolExecutionStart {
                generation: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: json!({"command": "pwd"}),
            },
            RuntimeEvent::ToolExecutionUpdate {
                generation: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: json!({"command": "pwd"}),
                partial_result: json!({"content": "part-1"}),
            },
            RuntimeEvent::ToolExecutionUpdate {
                generation: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: json!({"command": "pwd"}),
                partial_result: json!({"content": "part-2"}),
            },
        ];
        let mid = assert_replay(&raw);
        assert_eq!(
            retained(&mid).iter().map(AsRef::as_ref).collect::<Vec<_>>(),
            vec![&raw[0], &raw[2]]
        );
        raw.push(RuntimeEvent::ToolExecutionEnd {
            generation: 1,
            tool_call_id: "call-1".to_owned(),
            tool_name: "bash".to_owned(),
            result: json!({"content": "/project"}),
            is_error: false,
        });
        let finished = assert_replay(&raw);
        assert_eq!(
            retained(&finished)
                .iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>(),
            vec![&raw[0], &raw[3]]
        );
    }

    #[test]
    fn snapshots_and_queue_events_are_retained_as_merge_barriers() {
        let raw = vec![
            text("a"),
            RuntimeEvent::AssistantTextSnapshot {
                generation: 1,
                text: "a".to_owned(),
            },
            text("b"),
            RuntimeEvent::QueueUpdate {
                generation: 1,
                steering: vec!["steer".to_owned()],
                follow_up: vec!["later".to_owned()],
            },
            text("c"),
        ];
        let mut turn = projection();
        assert!(turn.begin(10));
        for event in &raw {
            turn.push(event.clone());
        }
        assert_eq!(
            retained(&turn.snapshot())
                .iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>(),
            raw.iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn overflow_stays_truncated_after_more_events_until_settle() {
        let mut turn = TurnProjection::new(TurnLimits {
            max_events: 1,
            max_bytes: usize::MAX,
        });
        assert!(turn.begin(10));
        turn.push(text("a"));
        turn.push(user("steer"));
        turn.push(text("b"));
        assert!(!turn.begin(20));
        assert_eq!(
            turn.snapshot(),
            TurnSnapshot {
                base_size: None,
                live: TurnLive::Truncated
            }
        );
        turn.settle();
        assert!(turn.begin(30));
        turn.push(text("new turn"));
        assert_eq!(retained(&turn.snapshot())[0].as_ref(), &text("new turn"));
    }

    #[test]
    fn unsafe_start_and_overlapping_begin_are_sticky_until_settle() {
        let mut turn = projection();
        turn.push(text("attached mid-turn"));
        assert_eq!(turn.snapshot().live, TurnLive::Truncated);
        assert!(!turn.begin(10));
        turn.push(text("ignored"));
        assert_eq!(turn.snapshot().live, TurnLive::Truncated);
        turn.settle();
        assert!(turn.begin(20));
        assert!(!turn.begin(30));
        assert_eq!(turn.snapshot().live, TurnLive::Truncated);
        turn.settle();
        assert!(turn.begin(40));
    }

    #[test]
    fn settle_resets_active_and_truncated_turns_to_empty_idle() {
        let mut turn = projection();
        let idle = TurnSnapshot {
            base_size: None,
            live: TurnLive::Idle,
        };
        assert_eq!(turn.snapshot(), idle);
        assert!(turn.begin(10));
        assert!(retained(&turn.snapshot()).is_empty());
        turn.push(text("reply"));
        turn.settle();
        assert_eq!(turn.snapshot(), idle);
        assert_eq!(turn.bytes, 0);
        turn.truncate();
        turn.settle();
        turn.settle();
        assert_eq!(turn.snapshot(), idle);
        assert!(turn.begin(20));
    }

    #[test]
    fn snapshots_are_cheap_and_immutable_after_merges_and_reset() {
        let mut turn = projection();
        assert!(turn.begin(10));
        turn.push(user("prompt"));
        turn.push(text("a"));
        let before = turn.snapshot();
        assert!(Arc::ptr_eq(retained(&before), retained(&turn.snapshot())));
        turn.push(text("b"));
        let after = turn.snapshot();
        assert!(!Arc::ptr_eq(retained(&before), retained(&after)));
        assert!(Arc::ptr_eq(&retained(&before)[0], &retained(&after)[0]));
        assert_eq!(retained(&before)[1].as_ref(), &text("a"));
        assert_eq!(retained(&after)[1].as_ref(), &text("ab"));
        turn.settle();
        assert_eq!(before.base_size, Some(10));
        assert_eq!(retained(&before)[1].as_ref(), &text("a"));
    }
}
