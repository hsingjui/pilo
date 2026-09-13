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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthMethod {
    #[default]
    Agent,
    Password,
    Key,
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
        #[serde(default)]
        auth_method: SshAuthMethod,
    },
    Direct {
        hostname: String,
        port: Option<u16>,
        user: Option<String>,
        identity_file: Option<String>,
        #[serde(default)]
        auth_method: SshAuthMethod,
        #[serde(default)]
        proxy_jump: Option<String>,
    },
}

impl SshTarget {
    pub fn auth_method(&self) -> &SshAuthMethod {
        match self {
            Self::ConfigHost { auth_method, .. } | Self::Direct { auth_method, .. } => auth_method,
        }
    }
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
                        auth_method: SshAuthMethod::Agent,
                    },
                },
                serde_json::json!({
                    "type": "ssh",
                    "target": { "type": "config_host", "host": "devbox", "authMethod": "agent" }
                }),
            ),
        ];

        for (kind, expected) in cases {
            assert_eq!(serde_json::to_value(kind).unwrap(), expected);
        }
    }

    #[test]
    fn old_ssh_targets_default_to_agent_auth() {
        let target: SshTarget = serde_json::from_value(serde_json::json!({
            "type": "direct",
            "hostname": "192.0.2.10",
            "port": 2222,
            "user": "deploy",
            "identityFile": "~/.ssh/deploy"
        }))
        .unwrap();

        assert_eq!(target.auth_method(), &SshAuthMethod::Agent);
    }

    #[test]
    fn ssh_direct_target_keeps_explicit_options() {
        let target = SshTarget::Direct {
            hostname: "192.0.2.10".to_owned(),
            port: Some(2222),
            user: Some("deploy".to_owned()),
            identity_file: Some("~/.ssh/deploy".to_owned()),
            auth_method: SshAuthMethod::Key,
            proxy_jump: Some("jump@example.com:2200".to_owned()),
        };

        assert_eq!(
            serde_json::to_value(target).unwrap(),
            serde_json::json!({
                "type": "direct",
                "hostname": "192.0.2.10",
                "port": 2222,
                "user": "deploy",
                "identityFile": "~/.ssh/deploy",
                "authMethod": "key",
                "proxyJump": "jump@example.com:2200"
            })
        );
    }
}
