pub use pilo_protocol::FsEntry;
use pilo_protocol::MAX_BINARY_PAYLOAD_BYTES;
use serde_json::json;

use crate::domain::{Connection, Project};

use super::server_client::ServerManager;

pub async fn read_dir(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<Vec<FsEntry>, String> {
    servers
        .request_typed(
            &project.connection,
            "fs.read_dir",
            json!({ "project": project.path, "path": path }),
        )
        .await
}

pub async fn read_connection_dir(
    servers: &ServerManager,
    connection: &Connection,
    path: &str,
) -> Result<Vec<FsEntry>, String> {
    let relative = path.trim().trim_start_matches('/');
    servers
        .request_typed(
            connection,
            "fs.read_dir",
            json!({ "project": "/", "path": relative }),
        )
        .await
}

pub async fn read_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<Vec<u8>, String> {
    let (_, binary) = servers
        .request_with_binary(
            &project.connection,
            "fs.read_file",
            json!({ "project": project.path, "path": path }),
            Vec::new(),
        )
        .await?;
    if binary.len() != 1 {
        return Err(format!(
            "fs.read_file expected one binary attachment, got {}",
            binary.len()
        ));
    }
    Ok(binary.into_iter().next().expect("binary length checked"))
}

pub async fn write_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
    data: &[u8],
) -> Result<(), String> {
    if data.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "file write is {} bytes; pilo-server limit is {} bytes",
            data.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    servers
        .request_with_binary(
            &project.connection,
            "fs.write_file",
            json!({
                "project": project.path,
                "path": path,
            }),
            vec![data.to_vec()],
        )
        .await
        .map(|_| ())
}

pub async fn stat(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<FsEntry, String> {
    servers
        .request_typed(
            &project.connection,
            "fs.stat",
            json!({ "project": project.path, "path": path }),
        )
        .await
}

pub async fn mkdir(servers: &ServerManager, project: &Project, path: &str) -> Result<(), String> {
    servers
        .request(
            &project.connection,
            "fs.mkdir",
            json!({ "project": project.path, "path": path }),
        )
        .await
        .map(|_| ())
}

pub async fn rename(
    servers: &ServerManager,
    project: &Project,
    from: &str,
    to: &str,
) -> Result<(), String> {
    servers
        .request(
            &project.connection,
            "fs.rename",
            json!({ "project": project.path, "from": from, "to": to }),
        )
        .await
        .map(|_| ())
}

pub async fn remove(servers: &ServerManager, project: &Project, path: &str) -> Result<(), String> {
    servers
        .request(
            &project.connection,
            "fs.remove",
            json!({ "project": project.path, "path": path }),
        )
        .await
        .map(|_| ())
}

pub async fn search(
    servers: &ServerManager,
    project: &Project,
    query: &str,
) -> Result<Vec<String>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    servers
        .request_typed(
            &project.connection,
            "fs.search",
            json!({ "project": project.path, "query": query }),
        )
        .await
}
