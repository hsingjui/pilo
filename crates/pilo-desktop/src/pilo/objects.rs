//! The structured values the `Pilo` class takes and returns in TypeScript.

use nsh_core::{JsonValue, prelude::*};
use pilo_domain::SessionReadState;
use pilo_runtime::preferences::PreferencesSnapshot;
use serde::Deserialize;

/// A session file's size and exact modification time, as returned by the runtime.
#[derive(JsObject)]
pub struct NativeHistoryFingerprint {
    pub file_size: f64,
    pub file_mtime_ns: String,
}

#[derive(Default, JsObject)]
pub struct NativeHistoryOptions {
    pub start_message: Option<f64>,
    pub message_limit: Option<f64>,
    pub include_message_index: Option<bool>,
    pub fingerprint: Option<NativeHistoryFingerprint>,
}

/// The initial project catalog and runtime snapshots with their event cut.
#[derive(JsObject, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    /// The runtime event sequence before reading snapshot state.
    pub event_sequence: u64,
    /// Projects with their saved connection and metadata.
    pub projects: Vec<JsonValue>,
    /// Snapshots of chat sessions currently held by the runtime.
    pub chat_sessions: Vec<JsonValue>,
    pub preferences: NativePreferencesSnapshot,
}

/// Desktop-only preferences shared with the previous shell.
#[derive(JsObject)]
pub struct NativeDesktopSettings {
    pub show_shortcut: String,
    pub exit_on_close: bool,
}

/// The current revision and complete Host preference values.
#[derive(JsObject, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreferencesSnapshot {
    pub revision: u64,
    pub values: JsonValue,
}

impl From<PreferencesSnapshot> for NativePreferencesSnapshot {
    fn from(snapshot: PreferencesSnapshot) -> Self {
        Self {
            revision: snapshot.revision,
            values: JsonValue::Object(snapshot.values),
        }
    }
}

/// The completed and acknowledged revisions for a saved session.
#[derive(JsObject, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionReadState {
    pub project_id: String,
    pub session_path: String,
    pub completed_revision: u64,
    pub read_revision: u64,
}

impl From<SessionReadState> for NativeSessionReadState {
    fn from(state: SessionReadState) -> Self {
        Self {
            project_id: state.project_id,
            session_path: state.session_path,
            completed_revision: state.completed_revision,
            read_revision: state.read_revision,
        }
    }
}

/// Arguments for starting or resuming a Pi chat.
#[derive(JsObject)]
pub struct NativeStartChatInput {
    pub project_id: String,
    pub session_key: String,
    pub session_path: Option<String>,
    pub no_session: Option<bool>,
    pub builtin_extensions: Option<Vec<NativeChatBuiltinExtension>>,
}

/// An explicitly selected Host-provided Pi extension.
#[derive(JsObject)]
pub struct NativeChatBuiltinExtension {
    pub id: String,
}
