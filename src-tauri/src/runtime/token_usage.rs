//! Per-message model usage (Pi `Usage`).
//!
//! Assistant messages always carry usage; tool results carry it only when the
//! tool performed nested model work. The live RPC event stream and the session
//! JSONL report the same shape, so the field mapping lives here once and both
//! readers share it.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

impl TokenUsage {
    pub fn is_empty(&self) -> bool {
        self.total == 0
            && self.input == 0
            && self.output == 0
            && self.cache_read == 0
            && self.cache_write == 0
            && self.cost.is_none()
    }

    /// `None` when the payload carries no usage at all, so callers can render
    /// nothing instead of a row of zeros.
    pub fn from_json(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        if !value.is_object() {
            return None;
        }
        let counter = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
        let usage = Self {
            input: counter("input"),
            output: counter("output"),
            cache_read: counter("cacheRead"),
            cache_write: counter("cacheWrite"),
            // Pi reports `totalTokens`; summing keeps older or partial payloads usable.
            total: value
                .get("totalTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cost: value
                .get("cost")
                .and_then(|cost| cost.get("total"))
                .and_then(Value::as_f64),
        };
        let total = if usage.total > 0 {
            usage.total
        } else {
            usage
                .input
                .saturating_add(usage.output)
                .saturating_add(usage.cache_read)
                .saturating_add(usage.cache_write)
        };
        let usage = Self { total, ..usage };
        (!usage.is_empty()).then_some(usage)
    }
    /// 累加同一轮次中多次模型调用（多步工具执行）的用量与费用。
    pub fn accumulate(&mut self, other: Self) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.total = self.total.saturating_add(other.total);
        if let Some(other_cost) = other.cost {
            let current = self.cost.unwrap_or(0.0);
            self.cost = Some(current + other_cost);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::TokenUsage;

    #[test]
    fn reads_every_counter_and_cost() {
        let usage = TokenUsage::from_json(Some(&json!({
            "input": 10,
            "output": 5,
            "cacheRead": 20,
            "cacheWrite": 2,
            "totalTokens": 37,
            "cost": { "total": 0.0125 },
        })))
        .expect("usage");

        assert_eq!(usage.input, 10);
        assert_eq!(usage.output, 5);
        assert_eq!(usage.cache_read, 20);
        assert_eq!(usage.cache_write, 2);
        assert_eq!(usage.total, 37);
        assert_eq!(usage.cost, Some(0.0125));
    }

    #[test]
    fn falls_back_to_the_counter_sum_without_total_tokens() {
        let usage =
            TokenUsage::from_json(Some(&json!({ "input": 10, "output": 5 }))).expect("usage");

        assert_eq!(usage.total, 15);
        assert_eq!(usage.cost, None);
    }

    #[test]
    fn tolerates_missing_or_empty_payloads() {
        assert_eq!(TokenUsage::from_json(None), None);
        assert_eq!(TokenUsage::from_json(Some(&json!("usage"))), None);
        assert_eq!(TokenUsage::from_json(Some(&json!({}))), None);
        assert_eq!(TokenUsage::from_json(Some(&json!({ "input": 0 }))), None);
    }

    #[test]
    fn accumulates_multiple_turns_usage_and_costs() {
        let mut u1 = TokenUsage {
            input: 100,
            output: 20,
            cache_read: 50,
            cache_write: 10,
            total: 180,
            cost: Some(0.005),
        };
        let u2 = TokenUsage {
            input: 200,
            output: 40,
            cache_read: 100,
            cache_write: 0,
            total: 340,
            cost: Some(0.010),
        };
        u1.accumulate(u2);
        assert_eq!(u1.input, 300);
        assert_eq!(u1.output, 60);
        assert_eq!(u1.cache_read, 150);
        assert_eq!(u1.cache_write, 10);
        assert_eq!(u1.total, 520);
        assert!((u1.cost.unwrap() - 0.015).abs() < 1e-6);
    }
}
