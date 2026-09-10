use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub kind: ConnectionKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionKind {
    Local,
    Wsl { distro: String },
    Ssh { host: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConnection {
    pub id: String,
    pub name: String,
}

impl Default for LocalConnection {
    fn default() -> Self {
        Self {
            id: "local".to_owned(),
            name: "Local".to_owned(),
        }
    }
}

impl From<LocalConnection> for Connection {
    fn from(connection: LocalConnection) -> Self {
        Self {
            id: connection.id,
            name: connection.name,
            kind: ConnectionKind::Local,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentInfo {
    pub cwd: PathBuf,
    pub git_branch: Option<String>,
    pub pi_executable: PathBuf,
    pub pi_version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_kinds_are_stably_tagged() {
        let cases = [
            (
                ConnectionKind::Local,
                serde_json::json!({ "type": "local" }),
            ),
            (
                ConnectionKind::Wsl {
                    distro: "Debian".to_owned(),
                },
                serde_json::json!({ "type": "wsl", "distro": "Debian" }),
            ),
            (
                ConnectionKind::Ssh {
                    host: "devbox".to_owned(),
                },
                serde_json::json!({ "type": "ssh", "host": "devbox" }),
            ),
        ];

        for (kind, expected) in cases {
            assert_eq!(serde_json::to_value(kind).unwrap(), expected);
        }
    }

    #[test]
    fn local_connection_maps_to_generic_connection() {
        let connection = Connection::from(LocalConnection::default());

        assert_eq!(connection.id, "local");
        assert_eq!(connection.name, "Local");
        assert_eq!(connection.kind, ConnectionKind::Local);
    }

    #[test]
    fn local_environment_info_uses_camel_case_fields() {
        let info = LocalEnvironmentInfo {
            cwd: PathBuf::from("/workspace"),
            git_branch: Some("main".to_owned()),
            pi_executable: PathBuf::from("/bin/pi"),
            pi_version: "0.85.1".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({
                "cwd": "/workspace",
                "gitBranch": "main",
                "piExecutable": "/bin/pi",
                "piVersion": "0.85.1"
            })
        );
    }
}
