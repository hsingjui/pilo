use serde_json::Value;

use super::events::{RuntimeErrorCode, RuntimeEvent};
use super::pi_event_adapters::{
    adapt_auto_retry_end, adapt_auto_retry_start, adapt_compaction_end, adapt_compaction_start,
    adapt_extension_error, adapt_extension_ui_request, adapt_message_update, adapt_queue_update,
    adapt_summarization_retry_attempt_start, adapt_summarization_retry_scheduled,
    adapt_tool_execution_end, adapt_tool_execution_start, adapt_tool_execution_update,
    assistant_text, is_pilo_correlated_response, message_text,
};
use super::token_usage::TokenUsage;

#[derive(Default)]
pub struct PiEventAdapter {
    finalized_text: String,
    stop_reason: Option<String>,
    error_message: Option<String>,
    usage: Option<TokenUsage>,
}

impl PiEventAdapter {
    pub fn adapt(&mut self, generation: u64, message: &Value) -> Vec<RuntimeEvent> {
        match message.get("type").and_then(Value::as_str) {
            Some("message_start") => self.adapt_message_start(generation, message),
            Some("message_update") => adapt_message_update(generation, message),
            Some("message_end") => self.adapt_message_end(generation, message),
            Some("tool_execution_start") => adapt_tool_execution_start(generation, message),
            Some("tool_execution_update") => adapt_tool_execution_update(generation, message),
            Some("tool_execution_end") => adapt_tool_execution_end(generation, message),
            Some("queue_update") => adapt_queue_update(generation, message),
            Some("compaction_start") => adapt_compaction_start(generation, message),
            Some("compaction_end") => adapt_compaction_end(generation, message),
            Some("auto_retry_start") => adapt_auto_retry_start(generation, message),
            Some("auto_retry_end") => adapt_auto_retry_end(generation, message),
            Some("summarization_retry_scheduled") => {
                adapt_summarization_retry_scheduled(generation, message)
            }
            Some("summarization_retry_attempt_start") => {
                adapt_summarization_retry_attempt_start(generation, message)
            }
            Some("summarization_retry_finished") => {
                vec![RuntimeEvent::SummarizationRetryFinished { generation }]
            }
            Some("extension_ui_request") => adapt_extension_ui_request(generation, message),
            Some("extension_error") => adapt_extension_error(generation, message),
            Some("agent_end") => {
                self.remember_agent_end(message);
                Vec::new()
            }
            Some("agent_settled") => self.adapt_agent_settled(generation),
            Some("response")
                if message.get("success").and_then(Value::as_bool) == Some(false)
                    && !is_pilo_correlated_response(message) =>
            {
                vec![RuntimeEvent::RuntimeError {
                    generation,
                    code: RuntimeErrorCode::RpcResponse,
                    message: message
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi RPC command failed")
                        .to_owned(),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn adapt_message_start(&mut self, generation: u64, event: &Value) -> Vec<RuntimeEvent> {
        let Some(message) = event.get("message") else {
            return Vec::new();
        };
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => vec![RuntimeEvent::AssistantMessageStart { generation }],
            Some("user") => {
                self.finalized_text.clear();
                self.stop_reason = None;
                self.error_message = None;
                message_text(message)
                    .filter(|text| !text.is_empty())
                    .map(|text| RuntimeEvent::UserMessageStart { generation, text })
                    .into_iter()
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn adapt_message_end(&mut self, generation: u64, event: &Value) -> Vec<RuntimeEvent> {
        let Some(message) = event.get("message") else {
            return Vec::new();
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            return Vec::new();
        }

        self.remember_completion_metadata(message);
        let Some(text) = assistant_text(message) else {
            return Vec::new();
        };
        self.finalized_text.push_str(&text);

        vec![RuntimeEvent::AssistantTextSnapshot {
            generation,
            text: self.finalized_text.clone(),
        }]
    }

    fn remember_completion_metadata(&mut self, message: &Value) {
        if let Some(stop_reason) = message.get("stopReason").and_then(Value::as_str) {
            self.stop_reason = Some(stop_reason.to_owned());
        }
        if let Some(error_message) = message.get("errorMessage").and_then(Value::as_str) {
            self.error_message = Some(error_message.to_owned());
        }
        if let Some(usage) = TokenUsage::from_json(message.get("usage")) {
            match &mut self.usage {
                Some(current) => current.accumulate(usage),
                None => self.usage = Some(usage),
            }
        }
    }

    fn remember_agent_end(&mut self, event: &Value) {
        let messages = match event.get("messages").and_then(Value::as_array) {
            Some(messages) => messages,
            None => return,
        };
        // 最后一条 assistant 消息决定终止原因与错误信息
        if let Some(last_assistant) = messages
            .iter()
            .rev()
            .find(|entry| entry.get("role").and_then(Value::as_str) == Some("assistant"))
        {
            self.stop_reason = last_assistant
                .get("stopReason")
                .and_then(Value::as_str)
                .map(str::to_owned);
            self.error_message = last_assistant
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        // 累加本轮多步（含工具调用链）所有 assistant 消息的 token 与费用消耗
        let mut total_usage: Option<TokenUsage> = None;
        for entry in messages {
            if entry.get("role").and_then(Value::as_str) == Some("assistant") {
                if let Some(usage) = TokenUsage::from_json(entry.get("usage")) {
                    match &mut total_usage {
                        Some(current) => current.accumulate(usage),
                        None => total_usage = Some(usage),
                    }
                }
            }
        }
        if total_usage.is_some() {
            self.usage = total_usage;
        }
    }

    fn adapt_agent_settled(&mut self, generation: u64) -> Vec<RuntimeEvent> {
        let event = RuntimeEvent::AssistantMessageEnd {
            generation,
            stop_reason: self.stop_reason.take(),
            error_message: self.error_message.take(),
            usage: self.usage.take(),
        };
        self.finalized_text.clear();
        vec![event]
    }
}

#[cfg(test)]
mod tests;
