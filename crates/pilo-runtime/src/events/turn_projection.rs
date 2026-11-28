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
#[path = "turn_projection_tests.rs"]
mod tests;
