//! Stable error categories and exit codes for scripts.

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    /// Bad arguments or stdin JSON, or the Host refused the parameters.
    InvalidInput,
    /// The App is not running or the endpoint is unreachable.
    Offline,
    /// CLI and Host protocol major versions differ.
    Incompatible,
    /// The Host refused the request in its current state (not found, busy, not running).
    Rejected,
    /// A write may or may not have been applied; query instead of retrying.
    OutcomeUnknown,
    Internal,
}

impl Category {
    pub fn name(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::Offline => "offline",
            Self::Incompatible => "incompatible",
            Self::Rejected => "rejected",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Internal => "internal",
        }
    }

    pub fn exit_code(self) -> i32 {
        match self {
            Self::Internal => 1,
            Self::InvalidInput => 2,
            Self::Offline => 3,
            Self::Incompatible => 4,
            Self::Rejected => 5,
            Self::OutcomeUnknown => 6,
        }
    }
}

#[derive(Debug)]
pub struct CliError {
    pub category: Category,
    /// The Host or transport error code, when there is one.
    pub code: Option<String>,
    pub message: String,
}

impl CliError {
    fn new(category: Category, message: impl Into<String>) -> Self {
        Self {
            category,
            code: None,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Category::InvalidInput, message)
    }

    pub fn offline(message: impl Into<String>) -> Self {
        Self::new(Category::Offline, message)
    }

    pub fn incompatible(message: impl Into<String>) -> Self {
        Self::new(Category::Incompatible, message)
    }

    pub fn outcome_unknown(message: impl Into<String>) -> Self {
        Self::new(Category::OutcomeUnknown, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Category::Internal, message)
    }

    /// Maps a Host `{code, message}` error. `write` marks requests whose
    /// timeout leaves the outcome unknown.
    pub fn from_host(error: &Value, write: bool) -> Self {
        let code = error["code"].as_str().unwrap_or("internal").to_owned();
        let message = error["message"]
            .as_str()
            .unwrap_or("Pilo reported an error")
            .to_owned();
        let category = match code.as_str() {
            "invalid_params" | "invalid_frame" => Category::InvalidInput,
            "not_found" | "conflict" | "forbidden" | "unauthorized" | "unsupported_method" => {
                Category::Rejected
            }
            "incompatible_protocol" => Category::Incompatible,
            "outcome_unknown" => Category::OutcomeUnknown,
            "timeout" if write => Category::OutcomeUnknown,
            "unavailable" | "timeout" => Category::Offline,
            _ => Category::Internal,
        };
        Self {
            category,
            code: Some(code),
            message,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({"error": {
            "category": self.category.name(),
            "code": self.code,
            "message": self.message,
        }})
    }
}
