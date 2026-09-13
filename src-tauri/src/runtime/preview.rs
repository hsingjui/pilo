use std::{collections::HashMap, net::TcpListener, process::Stdio, time::Duration};

use serde::Serialize;
use tokio::time::sleep;

use crate::domain::{ConnectionKind, Workspace};

use super::{server_client::ServerManager, ssh::ssh_tunnel_command};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    pub id: String,
    pub workspace_id: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub url: String,
    pub tunneled: bool,
}

struct PreviewSession {
    info: PreviewInfo,
    tunnel: Option<tokio::process::Child>,
}

#[derive(Default)]
pub struct PreviewManager {
    sessions: HashMap<String, PreviewSession>,
}

impl PreviewManager {
    pub async fn open(
        &mut self,
        workspace: &Workspace,
        remote_port: u16,
    ) -> Result<PreviewInfo, String> {
        if remote_port == 0 {
            return Err("preview port must be between 1 and 65535".to_owned());
        }
        let id = format!("preview:{}:{remote_port}", workspace.id);
        if let Some(existing) = self.sessions.get(&id) {
            return Ok(existing.info.clone());
        }

        let (local_port, tunnel) = match &workspace.connection.kind {
            ConnectionKind::Ssh { .. } => {
                let local_port = reserve_local_port()?;
                let mut child = ssh_tunnel_command(&workspace.connection, local_port, remote_port)?
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn()
                    .map_err(|error| format!("failed to start SSH preview tunnel: {error}"))?;
                sleep(Duration::from_millis(180)).await;
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("failed to inspect SSH preview tunnel: {error}"))?
                {
                    return Err(format!("SSH preview tunnel exited early: {status}"));
                }
                (local_port, Some(child))
            }
            ConnectionKind::Local | ConnectionKind::Wsl { .. } => (remote_port, None),
        };

        let info = PreviewInfo {
            id: id.clone(),
            workspace_id: workspace.id.clone(),
            remote_port,
            local_port,
            url: format!("http://127.0.0.1:{local_port}"),
            tunneled: tunnel.is_some(),
        };
        self.sessions.insert(
            id,
            PreviewSession {
                info: info.clone(),
                tunnel,
            },
        );
        Ok(info)
    }

    pub async fn close(&mut self, preview_id: &str) -> Result<(), String> {
        let Some(mut session) = self.sessions.remove(preview_id) else {
            return Ok(());
        };
        if let Some(mut child) = session.tunnel.take() {
            child
                .kill()
                .await
                .map_err(|error| format!("failed to stop SSH preview tunnel: {error}"))?;
            let _ = child.wait().await;
        }
        Ok(())
    }
}

pub async fn detect_ports(
    servers: &ServerManager,
    workspace: &Workspace,
) -> Result<Vec<u16>, String> {
    let mut ports: Vec<u16> = servers
        .request_typed(
            &workspace.connection,
            "preview.ports",
            serde_json::Value::Null,
        )
        .await?;
    ports.retain(|port| *port > 0);
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

fn reserve_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("failed to reserve local preview port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("failed to read local preview port: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_ephemeral_local_port() {
        let port = reserve_local_port().unwrap();
        assert!(port > 0);
    }
}
