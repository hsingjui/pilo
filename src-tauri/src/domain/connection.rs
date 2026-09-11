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
    Ssh { target: SshTarget },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistribution {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SshTarget {
    ConfigHost {
        host: String,
    },
    Direct {
        hostname: String,
        port: Option<u16>,
        user: Option<String>,
        identity_file: Option<String>,
    },
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
                    target: SshTarget::ConfigHost {
                        host: "devbox".to_owned(),
                    },
                },
                serde_json::json!({
                    "type": "ssh",
                    "target": { "type": "config_host", "host": "devbox" }
                }),
            ),
        ];

        for (kind, expected) in cases {
            assert_eq!(serde_json::to_value(kind).unwrap(), expected);
        }
    }

    #[test]
    fn ssh_direct_target_keeps_explicit_options() {
        let target = SshTarget::Direct {
            hostname: "192.0.2.10".to_owned(),
            port: Some(2222),
            user: Some("deploy".to_owned()),
            identity_file: Some("~/.ssh/deploy".to_owned()),
        };

        assert_eq!(
            serde_json::to_value(target).unwrap(),
            serde_json::json!({
                "type": "direct",
                "hostname": "192.0.2.10",
                "port": 2222,
                "user": "deploy",
                "identityFile": "~/.ssh/deploy"
            })
        );
    }
}
