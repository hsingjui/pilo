use serde::{Deserialize, Deserializer, Serialize, Serializer};

mod u64_string {
    use super::*;

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            String(String),
            Number(u64),
        }

        match Repr::deserialize(deserializer)? {
            Repr::String(value) => value.parse().map_err(serde::de::Error::custom),
            Repr::Number(value) => Ok(value),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub connection_id: String,
    pub project_id: String,
    pub pi_session_id: String,
    pub session_path: String,
    pub name: Option<String>,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u64,
    pub last_message_at: Option<String>,
    pub first_user_message_preview: Option<String>,
    pub file_size: u64,
    #[serde(with = "u64_string")]
    pub file_mtime_ns: u64,
    pub last_offset: u64,
    pub indexed_at_ms: u64,
    pub pinned: bool,
    pub title_override: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUiStateUpdate {
    pub pinned: bool,
    pub title_override: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReconcileResult {
    pub sessions: Vec<SessionIndexEntry>,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub unchanged: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(file_mtime_ns: u64) -> SessionIndexEntry {
        SessionIndexEntry {
            connection_id: "local".to_owned(),
            project_id: "project".to_owned(),
            pi_session_id: "session".to_owned(),
            session_path: "/tmp/session.jsonl".to_owned(),
            name: None,
            cwd: "/tmp".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
            message_count: 0,
            last_message_at: None,
            first_user_message_preview: None,
            file_size: 1,
            file_mtime_ns,
            last_offset: 0,
            indexed_at_ms: 0,
            pinned: false,
            title_override: None,
        }
    }

    #[test]
    fn session_mtime_serializes_losslessly_for_javascript() {
        let exact = 1_789_225_336_933_643_484_u64;
        let value = serde_json::to_value(session(exact)).unwrap();
        assert_eq!(value["fileMtimeNs"], exact.to_string());
        assert_eq!(
            serde_json::from_value::<SessionIndexEntry>(value)
                .unwrap()
                .file_mtime_ns,
            exact
        );
    }

    #[test]
    fn session_mtime_accepts_legacy_numeric_values() {
        let mut value = serde_json::to_value(session(123)).unwrap();
        value["fileMtimeNs"] = serde_json::json!(456);
        assert_eq!(
            serde_json::from_value::<SessionIndexEntry>(value)
                .unwrap()
                .file_mtime_ns,
            456
        );
    }
}
