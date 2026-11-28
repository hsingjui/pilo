use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The first frame a client sends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientHello {
    pub protocol: String,
    pub client: String,
    pub version: String,
}

/// The Host's successful reply to [`ClientHello`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHello {
    pub protocol: String,
    pub host_id: String,
    pub app_version: String,
    pub capabilities: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<Installation>,
}

/// Where the running App was launched from; only returned over local IPC.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installation {
    /// `installed`, `portable` or `appimage`.
    pub source: String,
    pub path: String,
}

/// Same major protocol version; minor and App patch differences do not block calls.
pub fn protocol_compatible(ours: &str, theirs: &str) -> bool {
    let major = |version: &str| version.split('.').next().map(str::to_owned);
    !theirs.is_empty() && major(ours) == major(theirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_major_version_has_to_match() {
        assert!(protocol_compatible("2.0", "2.0"));
        assert!(protocol_compatible("2.0", "2.7"));
        assert!(!protocol_compatible("2.0", "3.0"));
        assert!(!protocol_compatible("2.0", "1.9"));
        assert!(!protocol_compatible("2.0", ""));
    }
}
