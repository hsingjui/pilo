use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
pub use pilo_protocol::FsEntry;
use pilo_protocol::FsEntryKind;
use serde_json::json;

use pilo_domain::{Connection, Project};

use super::{host_api::ImageReadError, server_client::ServerManager};

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

pub(crate) use pilo_protocol::MAX_CHAT_FILE_BYTES;

/// The selected environment's server owns the destination, never WebUI.
pub(crate) async fn upload_chat_file(
    servers: &ServerManager,
    project: &Project,
    name: &str,
    data: &[u8],
) -> Result<String, String> {
    if data.len() > MAX_CHAT_FILE_BYTES {
        return Err("chat attachment exceeds the 10 MB limit".to_owned());
    }
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| format!("failed to generate attachment directory: {error}"))?;
    let id = URL_SAFE_NO_PAD.encode(random);
    let (value, binary) = servers
        .request_with_binary(
            &project.connection,
            "chat.file_upload",
            json!({ "id": id, "name": name }),
            vec![data.to_vec()],
        )
        .await?;
    if !binary.is_empty() {
        return Err("chat.file_upload returned unexpected binary attachments".to_owned());
    }
    serde_json::from_value(value)
        .map_err(|error| format!("invalid chat.file_upload response: {error}"))
}

/// The server restricts cleanup to its own generated attachment directories.
pub(crate) async fn remove_chat_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<(), String> {
    servers
        .request(
            &project.connection,
            "chat.file_remove",
            json!({ "path": path }),
        )
        .await
        .map(|_| ())
}

const MAX_PROJECT_IMAGE_BYTES: usize = 10 * 1024 * 1024;

fn project_image_too_large() -> ImageReadError {
    ImageReadError::TooLarge("project image exceeds the 10 MB limit".to_owned())
}

fn project_image_mime_type(path: &str) -> Result<&'static str, String> {
    if path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || path.contains(['\\', ':', '?', '#'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| part == "..")
    {
        return Err("image path must be relative and stay inside the project".to_owned());
    }
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        _ => Err("unsupported project image format".to_owned()),
    }
}

fn validate_image_bytes(bytes: &[u8], mime_type: &str) -> Result<(), ImageReadError> {
    if bytes.len() > MAX_PROJECT_IMAGE_BYTES {
        return Err(project_image_too_large());
    }
    let valid = match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Err("project image content does not match its format"
            .to_owned()
            .into());
    }
    Ok(())
}

/// Image-only surface for Markdown; never expose generic file reads to WebUI.
/// The server canonicalizes paths and rejects symlink escapes on every read.
pub async fn read_image(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<Vec<u8>, ImageReadError> {
    let mime_type = project_image_mime_type(path)?;
    let entry = stat(servers, project, path).await?;
    if entry.kind != FsEntryKind::File {
        return Err("project image must be a regular file".to_owned().into());
    }
    if entry.size > MAX_PROJECT_IMAGE_BYTES as u64 {
        return Err(project_image_too_large());
    }
    let bytes = read_file(servers, project, path).await?;
    validate_image_bytes(&bytes, mime_type)?;
    Ok(bytes)
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

pub async fn search(
    servers: &ServerManager,
    project: &Project,
    query: &str,
) -> Result<Vec<String>, String> {
    servers
        .request_typed(
            &project.connection,
            "fs.search",
            json!({ "project": project.path, "query": query }),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_image_paths_are_relative_and_image_only() {
        assert_eq!(
            project_image_mime_type("screenshots/page.PNG").unwrap(),
            "image/png"
        );
        assert_eq!(project_image_mime_type("./a.jpeg").unwrap(), "image/jpeg");
        for path in [
            "",
            "/tmp/a.png",
            "../a.png",
            "x/../a.png",
            "C:/a.png",
            "x\\a.png",
            "file://a.png",
            "a.png?x",
            "a.svg",
            "a.txt",
            "a\0.png",
        ] {
            assert!(project_image_mime_type(path).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn project_images_require_matching_binary_signatures() {
        for (mime, bytes) in [
            ("image/png", b"\x89PNG\r\n\x1a\n".as_slice()),
            ("image/jpeg", [0xff, 0xd8, 0xff].as_slice()),
            ("image/gif", b"GIF89a".as_slice()),
            ("image/webp", b"RIFF1234WEBP".as_slice()),
        ] {
            assert!(validate_image_bytes(bytes, mime).is_ok());
            assert!(validate_image_bytes(b"<html>not an image</html>", mime).is_err());
            assert!(validate_image_bytes(&[], mime).is_err());
        }
        assert!(validate_image_bytes(b"GIF89a", "image/png").is_err());
    }

    #[test]
    fn project_images_are_size_bounded_even_after_the_stat_check() {
        let mut bytes = vec![0; MAX_PROJECT_IMAGE_BYTES + 1];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        assert!(validate_image_bytes(&bytes, "image/png").is_err());
        bytes.pop();
        assert!(validate_image_bytes(&bytes, "image/png").is_ok());
    }
}
