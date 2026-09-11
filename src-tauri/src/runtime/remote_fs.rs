pub use pilo_protocol::FsEntry;
use serde_json::json;

use crate::domain::Workspace;

use super::server_client::ServerManager;

pub async fn read_dir(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
) -> Result<Vec<FsEntry>, String> {
    servers
        .request_typed(
            &workspace.connection,
            "fs.read_dir",
            json!({ "workspace": workspace.path, "path": path }),
        )
        .await
}

pub async fn read_file(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
) -> Result<Vec<u8>, String> {
    servers
        .request_typed(
            &workspace.connection,
            "fs.read_file",
            json!({ "workspace": workspace.path, "path": path }),
        )
        .await
}

pub async fn write_file(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
    data: &[u8],
) -> Result<(), String> {
    servers
        .request(
            &workspace.connection,
            "fs.write_file",
            json!({ "workspace": workspace.path, "path": path, "data": data }),
        )
        .await
        .map(|_| ())
}

pub async fn stat(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
) -> Result<FsEntry, String> {
    servers
        .request_typed(
            &workspace.connection,
            "fs.stat",
            json!({ "workspace": workspace.path, "path": path }),
        )
        .await
}

pub async fn mkdir(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
) -> Result<(), String> {
    servers
        .request(
            &workspace.connection,
            "fs.mkdir",
            json!({ "workspace": workspace.path, "path": path }),
        )
        .await
        .map(|_| ())
}

pub async fn rename(
    servers: &ServerManager,
    workspace: &Workspace,
    from: &str,
    to: &str,
) -> Result<(), String> {
    servers
        .request(
            &workspace.connection,
            "fs.rename",
            json!({ "workspace": workspace.path, "from": from, "to": to }),
        )
        .await
        .map(|_| ())
}

pub async fn remove(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
) -> Result<(), String> {
    servers
        .request(
            &workspace.connection,
            "fs.remove",
            json!({ "workspace": workspace.path, "path": path }),
        )
        .await
        .map(|_| ())
}

pub async fn search(
    servers: &ServerManager,
    workspace: &Workspace,
    query: &str,
) -> Result<Vec<String>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    servers
        .request_typed(
            &workspace.connection,
            "fs.search",
            json!({ "workspace": workspace.path, "query": query }),
        )
        .await
}
