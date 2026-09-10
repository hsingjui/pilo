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
    Ssh { target: SshTarget },
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
pub struct WslDistribution {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConnection {
    pub id: String,
    pub name: String,
    pub distro: String,
}

impl WslConnection {
    pub fn new(distro: String) -> Self {
        Self {
            id: format!("wsl:{distro}"),
            name: format!("WSL · {distro}"),
            distro,
        }
    }
}

impl From<WslConnection> for Connection {
    fn from(connection: WslConnection) -> Self {
        Self {
            id: connection.id,
            name: connection.name,
            kind: ConnectionKind::Wsl {
                distro: connection.distro,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub id: String,
    pub name: String,
    pub target: SshTarget,
}

impl SshConnection {
    pub fn from_target(target: SshTarget) -> Self {
        let (id, name) = match &target {
            SshTarget::ConfigHost { host } => {
                (format!("ssh:config:{host}"), format!("SSH · {host}"))
            }
            SshTarget::Direct {
                hostname,
                port,
                user,
                ..
            } => {
                let destination = match user.as_deref() {
                    Some(user) => format!("{user}@{hostname}"),
                    None => hostname.clone(),
                };
                let endpoint = match port {
                    Some(port) => format!("{destination}:{port}"),
                    None => destination,
                };
                (
                    format!("ssh:direct:{endpoint}"),
                    format!("SSH · {endpoint}"),
                )
            }
        };

        Self { id, name, target }
    }
}

impl From<SshConnection> for Connection {
    fn from(connection: SshConnection) -> Self {
        Self {
            id: connection.id,
            name: connection.name,
            kind: ConnectionKind::Ssh {
                target: connection.target,
            },
        }
    }
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslEnvironmentInfo {
    pub cwd: String,
    pub git_branch: Option<String>,
    pub pi_executable: String,
    pub pi_version: String,
    pub node_executable: String,
    pub node_version: String,
    pub git_executable: String,
    pub git_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentInfo {
    pub cwd: String,
    pub git_branch: Option<String>,
    pub pi_executable: String,
    pub pi_version: String,
    pub node_executable: String,
    pub node_version: String,
    pub git_executable: String,
    pub git_version: String,
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
    fn local_connection_maps_to_generic_connection() {
        let connection = Connection::from(LocalConnection::default());

        assert_eq!(connection.id, "local");
        assert_eq!(connection.name, "Local");
        assert_eq!(connection.kind, ConnectionKind::Local);
    }

    #[test]
    fn wsl_connection_maps_to_generic_connection() {
        let connection = Connection::from(WslConnection::new("Debian".to_owned()));

        assert_eq!(connection.id, "wsl:Debian");
        assert_eq!(connection.name, "WSL · Debian");
        assert_eq!(
            connection.kind,
            ConnectionKind::Wsl {
                distro: "Debian".to_owned()
            }
        );
        assert_eq!(
            serde_json::to_value(&connection).unwrap(),
            serde_json::json!({
                "id": "wsl:Debian",
                "name": "WSL · Debian",
                "kind": { "type": "wsl", "distro": "Debian" }
            })
        );
    }

    #[test]
    fn ssh_config_host_connection_maps_to_generic_connection() {
        let connection = Connection::from(SshConnection::from_target(SshTarget::ConfigHost {
            host: "devbox".to_owned(),
        }));

        assert_eq!(connection.id, "ssh:config:devbox");
        assert_eq!(connection.name, "SSH · devbox");
        assert_eq!(
            connection.kind,
            ConnectionKind::Ssh {
                target: SshTarget::ConfigHost {
                    host: "devbox".to_owned()
                }
            }
        );
        assert_eq!(
            serde_json::to_value(&connection).unwrap(),
            serde_json::json!({
                "id": "ssh:config:devbox",
                "name": "SSH · devbox",
                "kind": {
                    "type": "ssh",
                    "target": { "type": "config_host", "host": "devbox" }
                }
            })
        );
    }

    #[test]
    fn ssh_direct_connection_keeps_explicit_options() {
        let connection = SshConnection::from_target(SshTarget::Direct {
            hostname: "192.0.2.10".to_owned(),
            port: Some(2222),
            user: Some("deploy".to_owned()),
            identity_file: Some("~/.ssh/deploy".to_owned()),
        });

        assert_eq!(connection.id, "ssh:direct:deploy@192.0.2.10:2222");
        assert_eq!(connection.name, "SSH · deploy@192.0.2.10:2222");
        assert_eq!(
            serde_json::to_value(connection.target).unwrap(),
            serde_json::json!({
                "type": "direct",
                "hostname": "192.0.2.10",
                "port": 2222,
                "user": "deploy",
                "identityFile": "~/.ssh/deploy"
            })
        );
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
