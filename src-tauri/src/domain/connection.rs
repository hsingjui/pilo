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
}
