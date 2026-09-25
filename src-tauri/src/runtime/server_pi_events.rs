use serde_json::{Value, json};

use super::{
    debug_trace::runtime_trace,
    events::{RuntimeEvent, RuntimeEventSink},
    pi_events::PiEventAdapter,
};

const MAX_BUFFERED_RUNTIME_EVENTS: usize = 128;

pub(super) fn trace_pi_transport_event(stream_id: &str, data: &Value) {
    let Some(event_type) = data.get("type").and_then(Value::as_str) else {
        return;
    };
    if !matches!(
        event_type,
        "response"
            | "agent_start"
            | "agent_end"
            | "agent_settled"
            | "turn_start"
            | "turn_end"
            | "message_start"
            | "message_end"
            | "tool_execution_start"
            | "tool_execution_end"
            | "queue_update"
            | "compaction_start"
            | "compaction_end"
            | "auto_retry_start"
            | "auto_retry_end"
    ) {
        return;
    }
    runtime_trace(
        "server_pi.recv",
        None,
        Some(stream_id),
        json!({
            "event": event_type,
            "id": data.get("id"),
            "command": data.get("command"),
            "success": data.get("success"),
            "role": data.pointer("/message/role"),
            "stopReason": data.pointer("/message/stopReason"),
            "willRetry": data.get("willRetry"),
            "toolCallId": data.get("toolCallId"),
            "toolName": data.get("toolName"),
        }),
    );
}

pub(super) fn adapt_pi_rpc(
    adapter: &mut PiEventAdapter,
    generation: u64,
    data: Value,
) -> Vec<RuntimeEvent> {
    let adapted = adapter.adapt(generation, &data);
    let mut events = Vec::new();
    if data.get("type").and_then(Value::as_str) == Some("response") {
        events.push(RuntimeEvent::RpcMessage {
            generation,
            message: data,
        });
    }
    events.extend(adapted);

    events
}

pub(super) fn push_coalesced_runtime_event(buffer: &mut Vec<RuntimeEvent>, event: RuntimeEvent) {
    match event {
        RuntimeEvent::AssistantTextDelta { generation, delta } => {
            if let Some(RuntimeEvent::AssistantTextDelta {
                generation: previous_generation,
                delta: previous_delta,
            }) = buffer.last_mut()
                && *previous_generation == generation
            {
                previous_delta.push_str(&delta);
                return;
            }
            buffer.push(RuntimeEvent::AssistantTextDelta { generation, delta });
        }
        RuntimeEvent::AssistantThinkingDelta { generation, delta } => {
            if let Some(RuntimeEvent::AssistantThinkingDelta {
                generation: previous_generation,
                delta: previous_delta,
            }) = buffer.last_mut()
                && *previous_generation == generation
            {
                previous_delta.push_str(&delta);
                return;
            }
            buffer.push(RuntimeEvent::AssistantThinkingDelta { generation, delta });
        }
        RuntimeEvent::ToolExecutionUpdate {
            generation,
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => {
            if let Some(RuntimeEvent::ToolExecutionUpdate {
                generation: previous_generation,
                tool_call_id: previous_tool_call_id,
                tool_name: previous_tool_name,
                args: previous_args,
                partial_result: previous_partial_result,
            }) = buffer.last_mut()
                && *previous_generation == generation
                && *previous_tool_call_id == tool_call_id
            {
                *previous_tool_name = tool_name;
                *previous_args = args;
                *previous_partial_result = partial_result;
                return;
            }
            buffer.push(RuntimeEvent::ToolExecutionUpdate {
                generation,
                tool_call_id,
                tool_name,
                args,
                partial_result,
            });
        }
        other => buffer.push(other),
    }
}

pub(super) fn flush_runtime_events<S: RuntimeEventSink>(sink: &S, buffer: &mut Vec<RuntimeEvent>) {
    for event in buffer.drain(..) {
        sink.send(event);
    }
}

pub(super) fn dispatch_runtime_event<S: RuntimeEventSink>(
    sink: &S,
    buffer: &mut Vec<RuntimeEvent>,
    event: RuntimeEvent,
) {
    let buffered = matches!(
        event,
        RuntimeEvent::AssistantTextDelta { .. }
            | RuntimeEvent::AssistantThinkingDelta { .. }
            | RuntimeEvent::ToolExecutionUpdate { .. }
    );
    if buffered {
        push_coalesced_runtime_event(buffer, event);
        if buffer.len() >= MAX_BUFFERED_RUNTIME_EVENTS {
            flush_runtime_events(sink, buffer);
        }
        return;
    }

    flush_runtime_events(sink, buffer);
    sink.send(event);
}

pub(super) fn dispatch_runtime_events<S: RuntimeEventSink>(
    sink: &S,
    buffer: &mut Vec<RuntimeEvent>,
    events: impl IntoIterator<Item = RuntimeEvent>,
) {
    for event in events {
        dispatch_runtime_event(sink, buffer, event);
    }
}
