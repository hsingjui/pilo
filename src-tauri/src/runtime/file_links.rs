use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use pilo_protocol::MAX_BINARY_PAYLOAD_BYTES;
use pilo_server::file_links::{
    FileLinkMetadata, MAX_PREVIEW_BYTES, check_system_extension, check_system_header,
};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::domain::{ConnectionKind, Project};

use super::PiloRuntime;

fn is_html(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

fn file_url(value: &str) -> Result<(Url, String), String> {
    let invalid = || "only local file URLs without queries or fragments are supported".to_owned();
    let lower = value.to_ascii_lowercase();
    if value.len() > 4096
        || !lower.starts_with("file://")
        || lower.starts_with("file:////")
        || lower.starts_with("file://localhost//")
        || value.chars().any(char::is_control)
        || value.contains('\\')
        || lower.contains("%2f")
        || lower.contains("%5c")
    {
        return Err(invalid());
    }
    for (index, byte) in value.bytes().enumerate() {
        if byte == b'%'
            && !value
                .as_bytes()
                .get(index + 1..index + 3)
                .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
        {
            return Err(invalid());
        }
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "file"
        || url.host_str().is_some_and(|host| host != "localhost")
        || url.path().starts_with("//")
        || url.path().ends_with('/')
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    // Decode independently of the host OS: Windows cannot to_file_path a POSIX URL.
    let encoded = url.path().as_bytes();
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' {
            let pair = encoded.get(index + 1..index + 3).ok_or_else(invalid)?;
            let pair = std::str::from_utf8(pair).map_err(|_| invalid())?;
            bytes.push(u8::from_str_radix(pair, 16).map_err(|_| invalid())?);
            index += 3;
        } else {
            bytes.push(encoded[index]);
            index += 1;
        }
    }
    let path = String::from_utf8(bytes).map_err(|_| invalid())?;
    let drive_path = path.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(2) == Some(&b':')
        && path.as_bytes().get(3) == Some(&b'/');
    let suffix = if drive_path { &path[4..] } else { &path };
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.ends_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || suffix.contains(':')
    {
        return Err(invalid());
    }
    Ok((
        url,
        if drive_path {
            path[1..].to_owned()
        } else {
            path
        },
    ))
}

fn file_path(value: &str) -> Result<PathBuf, String> {
    let invalid = || "only local file URLs without queries or fragments are supported".to_owned();
    let (url, _) = file_url(value)?;
    let path = url.to_file_path().map_err(|_| invalid())?;
    let text = path.to_str().ok_or_else(invalid)?;
    // Reject UNC/device paths and Windows alternate data streams, not just URL hosts.
    if !path.is_absolute()
        || text.starts_with("//")
        || text.starts_with(r"\\")
        || text.chars().any(char::is_control)
        || text.get(2..).is_some_and(|suffix| suffix.contains(':'))
    {
        return Err(invalid());
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileLinkPreview {
    path: String,
    content: String,
}

async fn checked_file_path(url: &str) -> Result<PathBuf, String> {
    let path = tokio::fs::canonicalize(file_path(url)?)
        .await
        .map_err(|error| format!("file link is not accessible: {error}"))?;
    if !tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("file link is not accessible: {error}"))?
        .is_file()
    {
        return Err("file link must resolve to a regular file".to_owned());
    }
    Ok(path)
}

async fn read_preview(path: &Path) -> Result<FileLinkPreview, String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let metadata = file.metadata().await.map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_PREVIEW_BYTES {
        return Err(
            "file preview requires a regular UTF-8 text file no larger than 1 MiB".to_owned(),
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("failed to read file preview: {error}"))?;
    preview_from_bytes(path.to_string_lossy().into_owned(), bytes)
}

fn preview_from_bytes(path: String, bytes: Vec<u8>) -> Result<FileLinkPreview, String> {
    if bytes.len() as u64 > MAX_PREVIEW_BYTES || bytes.contains(&0) {
        return Err("file preview requires UTF-8 text no larger than 1 MiB".to_owned());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "file preview requires UTF-8 text".to_owned())?;
    Ok(FileLinkPreview { path, content })
}

async fn check_system_file(path: &Path) -> Result<(), String> {
    check_system_extension(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if tokio::fs::metadata(path)
            .await
            .map_err(|error| error.to_string())?
            .permissions()
            .mode()
            & 0o111
            != 0
        {
            return Err("executable files cannot be opened by file links".to_owned());
        }
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let mut header = Vec::new();
    file.take(4)
        .read_to_end(&mut header)
        .await
        .map_err(|error| error.to_string())?;
    check_system_header(&header)
}

async fn cache_document(app: &AppHandle, path: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve file link cache: {error}"))?
        .join("file-links");
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(&directory)
        .await
        .map_err(|error| format!("failed to create file link cache: {error}"))?;
    // A browser/application may still need the snapshot after this command returns.
    // Remove expired snapshots on subsequent opens, not immediately after launching.
    if let Ok(mut entries) = tokio::fs::read_dir(&directory).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Ok(metadata) = entry.metadata().await
                && metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(7 * 24 * 60 * 60))
            {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
    let name = path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.']);
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "file link document has no extension".to_owned())?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|error| format!("failed to name file link cache: {error}"))?;
    let name = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let cached = directory.join(format!("{name}.{extension}"));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&cached)
        .await
        .map_err(|error| format!("failed to create file link snapshot: {error}"))?;
    let result = async {
        file.write_all(bytes).await?;
        file.flush().await
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&cached).await;
        return Err(format!("failed to cache file link: {error}"));
    }
    Ok(cached)
}

async fn open_remote_file_link(
    app: &AppHandle,
    project: &Project,
    url: &str,
    preview: bool,
    html_only: bool,
) -> Result<Option<FileLinkPreview>, String> {
    let (_, path) = file_url(url)?;
    if html_only && !is_html(Path::new(&path)) {
        return Err("HTML report must resolve to an HTML file".to_owned());
    }
    if !preview {
        check_system_extension(Path::new(&path))?;
    }
    let runtime = app.state::<PiloRuntime>();
    let (metadata, mut binary) = runtime
        .servers
        .request_with_binary(
            &project.connection,
            "file_link.read",
            json!({ "path": path, "preview": preview }),
            Vec::new(),
        )
        .await?;
    let metadata: FileLinkMetadata = serde_json::from_value(metadata)
        .map_err(|error| format!("invalid file link response: {error}"))?;
    if binary.len() != 1 {
        return Err("file_link.read expected one binary attachment".to_owned());
    }
    let bytes = binary.remove(0);
    if preview {
        return preview_from_bytes(metadata.path, bytes).map(Some);
    }
    if bytes.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err("file link document exceeds the binary transport limit".to_owned());
    }
    check_system_extension(Path::new(&metadata.path))?;
    if html_only && !is_html(Path::new(&metadata.path)) {
        return Err("HTML report must resolve to an HTML file".to_owned());
    }
    check_system_header(&bytes[..bytes.len().min(4)])?;
    let cached = cache_document(app, &metadata.path, &bytes).await?;
    let result = async {
        check_system_file(&cached).await?;
        app.opener()
            .open_path(cached.to_string_lossy(), None::<&str>)
            .map_err(|error| format!("failed to open file link: {error}"))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&cached).await;
    }
    result.map(|()| None)
}

pub(crate) async fn open_file_link(
    app: &AppHandle,
    project: &Project,
    url: &str,
    preview: bool,
) -> Result<Option<FileLinkPreview>, String> {
    if !matches!(project.connection.kind, ConnectionKind::Local) {
        return open_remote_file_link(app, project, url, preview, false).await;
    }
    let path = checked_file_path(url).await?;
    if preview {
        return read_preview(&path).await.map(Some);
    }
    // Validate both names: a harmless symlink name must not disguise an executable.
    check_system_extension(&file_path(url)?)?;
    check_system_file(&path).await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("failed to open file link: {error}"))?;
    Ok(None)
}

// Retain the original HTML-only command contract for existing callers.
pub(crate) async fn open(app: &AppHandle, project: &Project, url: &str) -> Result<(), String> {
    if !matches!(project.connection.kind, ConnectionKind::Local) {
        return open_remote_file_link(app, project, url, false, true)
            .await
            .map(|_| ());
    }
    if !is_html(&file_path(url)?) || !is_html(&checked_file_path(url).await?) {
        return Err("HTML report must resolve to an HTML file".to_owned());
    }
    open_file_link(app, project, url, false).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_local_file_urls() {
        #[cfg(not(windows))]
        for url in [
            "file:///Users/example/.answer-me-with-html/pages/report.html",
            "file://localhost/tmp/report.HTM",
            "file:///tmp/%E6%8A%A5%E5%91%8A%20page.html",
        ] {
            assert!(file_path(url).is_ok(), "{url}");
        }
        #[cfg(windows)]
        assert_eq!(
            file_path("file:///C:/Users/example/My%20Pages/report.html").unwrap(),
            PathBuf::from(r"C:\Users\example\My Pages\report.html")
        );
    }

    #[test]
    fn decodes_remote_paths_independently_of_the_desktop_os() {
        for (url, expected) in [
            (
                "file:///root/project/report.html",
                "/root/project/report.html",
            ),
            (
                "file://localhost/home/user/My%20Pages/%E6%8A%A5%E5%91%8A.md",
                "/home/user/My Pages/报告.md",
            ),
            (
                "file:///C:/Users/example/My%20Pages/report.html",
                "C:/Users/example/My Pages/report.html",
            ),
            ("file:///tmp/100%25.md", "/tmp/100%.md"),
        ] {
            assert_eq!(file_url(url).unwrap().1, expected, "{url}");
        }
    }

    #[test]
    fn remote_previews_preserve_the_canonical_path_and_validate_bytes() {
        let preview = preview_from_bytes(
            "/home/user/报告.md".to_owned(),
            "# 说明".as_bytes().to_vec(),
        )
        .unwrap();
        assert_eq!(preview.path, "/home/user/报告.md");
        assert_eq!(preview.content, "# 说明");
        for bytes in [
            vec![0],
            vec![0xff],
            vec![b'a'; MAX_PREVIEW_BYTES as usize + 1],
        ] {
            assert!(preview_from_bytes("/tmp/file.md".to_owned(), bytes).is_err());
        }
        assert!(preview_from_bytes("/tmp/empty.rs".to_owned(), Vec::new()).is_ok());
    }

    #[tokio::test]
    async fn checks_existence_file_type_and_symlink_target_before_opening() {
        // Keep fixtures within this checkout, not the user's system temp directory.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target")
            .join(format!("file-link-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let report = root.join("report.html");
        std::fs::write(&report, "<!doctype html><title>Report</title>").unwrap();
        let file_url = |path: &Path| Url::from_file_path(path).unwrap().to_string();
        assert_eq!(
            checked_file_path(&file_url(&report)).await.unwrap(),
            std::fs::canonicalize(&report).unwrap()
        );
        assert!(
            checked_file_path(&file_url(&root.join("missing.html")))
                .await
                .is_err()
        );
        let directory = root.join("directory.html");
        std::fs::create_dir_all(&directory).unwrap();
        assert!(checked_file_path(&file_url(&directory)).await.is_err());
        #[cfg(unix)]
        {
            let executable = root.join("program.sh");
            std::fs::write(&executable, "#!/bin/sh").unwrap();
            let link = root.join("disguised.html");
            std::os::unix::fs::symlink(&executable, &link).unwrap();
            let canonical = checked_file_path(&file_url(&link)).await.unwrap();
            assert!(check_system_file(&canonical).await.is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn previews_bounded_utf8_text_and_blocks_executable_system_opens() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target")
            .join(format!("file-preview-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for (name, content) in [
            ("README.md", "# 说明"),
            ("main.rs", "fn main() {}"),
            ("empty.py", ""),
        ] {
            let path = root.join(name);
            std::fs::write(&path, content).unwrap();
            assert_eq!(read_preview(&path).await.unwrap().content, content);
        }
        for (name, content) in [
            ("binary.rs", vec![0, 1]),
            ("invalid.md", vec![255]),
            ("large.md", vec![b'a'; MAX_PREVIEW_BYTES as usize + 1]),
        ] {
            let path = root.join(name);
            std::fs::write(&path, content).unwrap();
            assert!(read_preview(&path).await.is_err(), "{name}");
        }
        for name in [
            "app.EXE",
            "app.exe .",
            "run.cmd",
            "link.lnk",
            "link.url",
            "run.desktop",
            "run.ps1",
            "run.js",
        ] {
            assert!(check_system_extension(Path::new(name)).is_err(), "{name}");
        }
        let sandbox = root.join("sandbox.wsb");
        std::fs::write(
            &sandbox,
            "<Configuration><LogonCommand><Command>cmd.exe</Command></LogonCommand></Configuration>",
        )
        .unwrap();
        assert!(check_system_file(&sandbox).await.is_err());
        let document = root.join("document.pdf");
        std::fs::write(&document, b"%PDF").unwrap();
        assert!(check_system_file(&document).await.is_ok());
        for header in [b"MZxx", b"\x7fELF", b"#!/x", &[0xcf, 0xfa, 0xed, 0xfe]] {
            std::fs::write(&document, header).unwrap();
            assert!(check_system_file(&document).await.is_err());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = root.join("script.txt");
            std::fs::write(&script, "print('safe preview')").unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(check_system_file(&script).await.is_err());
            assert!(read_preview(&script).await.is_ok());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn system_open_only_allows_known_document_extensions() {
        for name in [
            "report.HTML",
            "report.htm",
            "document.pdf",
            "photo.png",
            "notes.txt",
        ] {
            assert!(check_system_extension(Path::new(name)).is_ok(), "{name}");
        }
        for name in [
            "sandbox.wsb",
            "sandbox.WSB",
            "sandbox.wsb .",
            "unknown.custom",
            "no-extension",
            "macro.docm",
            "image.svg",
        ] {
            assert!(check_system_extension(Path::new(name)).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_network_paths_and_unsafe_urls() {
        for url in [
            "https://example.com/report.html",
            "javascript:alert(1)",
            "file://server/share/report.html",
            "file:////server/share/report.html",
            "file:///tmp/report.html/",
            "file:///tmp/report.html?x=1",
            "file:///tmp/report.html#section",
            "file:///tmp/report.html?",
            "file:///tmp/report.html#",
            "file:///tmp/report%00.html",
            "file:///tmp/report%0a.html",
            "file:///tmp/%2fserver/report.html",
            "file:///C:/report.exe:payload.html",
            "file:///tmp/report\\page.html",
            "file:///tmp/report%.md",
            "file:///tmp/report%FF.md",
            "file:///tmp/report%5cpage.html",
            "file:///%2fserver/share/report.html",
            "file:///tmp/report%7f.md",
        ] {
            assert!(file_url(url).is_err(), "{url}");
            assert!(file_path(url).is_err(), "{url}");
        }
    }
}
