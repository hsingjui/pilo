use std::{io::Read as _, path::Path};

use pilo_protocol::MAX_BINARY_PAYLOAD_BYTES;
use serde::{Deserialize, Serialize};

pub const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
pub(crate) struct ReadFileLinkParams {
    path: String,
    preview: bool,
}

#[derive(Deserialize, Serialize)]
pub struct FileLinkMetadata {
    pub path: String,
}

pub fn check_system_extension(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim_end_matches([' ', '.']);
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Unknown extensions can have executable associations (for example Windows .wsb).
    if !matches!(
        extension.as_str(),
        "html"
            | "htm"
            | "pdf"
            | "txt"
            | "md"
            | "markdown"
            | "csv"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "tif"
            | "tiff"
            | "avif"
    ) {
        return Err(
            "only supported document types can be opened by file links; preview code instead"
                .to_owned(),
        );
    }
    Ok(())
}

pub fn check_system_header(header: &[u8]) -> Result<(), String> {
    if header.starts_with(b"MZ")
        || header.starts_with(b"\x7fELF")
        || header.starts_with(b"#!")
        || matches!(
            header,
            [0xfe, 0xed, 0xfa, 0xce | 0xcf]
                | [0xce | 0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
        )
    {
        return Err("executables and scripts cannot be opened by file links".to_owned());
    }
    Ok(())
}

/// User-activated, read-only access on the selected connection, never a shell command.
pub(crate) fn read(params: ReadFileLinkParams) -> Result<(FileLinkMetadata, Vec<u8>), String> {
    let original = Path::new(&params.path);
    if !original.is_absolute()
        || params.path.len() > 4096
        || params.path.starts_with("//")
        || params.path.starts_with(r"\\")
        || params.path.chars().any(char::is_control)
    {
        return Err("file link requires an absolute path on the selected connection".to_owned());
    }
    let path = original
        .canonicalize()
        .map_err(|error| format!("file link is not accessible: {error}"))?;
    if !path
        .metadata()
        .map_err(|error| format!("file link is not accessible: {error}"))?
        .is_file()
    {
        return Err("file link must resolve to a regular file".to_owned());
    }
    if !params.preview {
        check_system_extension(original)?;
        check_system_extension(&path)?;
    }
    let file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let limit = if params.preview {
        MAX_PREVIEW_BYTES
    } else {
        MAX_BINARY_PAYLOAD_BYTES as u64
    };
    if !metadata.is_file() || metadata.len() > limit {
        return Err(format!(
            "file link requires a regular file no larger than {limit} bytes"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !params.preview && metadata.permissions().mode() & 0o111 != 0 {
            return Err("executable files cannot be opened by file links".to_owned());
        }
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read file link: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("file link exceeds the {limit} byte limit"));
    }
    if !params.preview {
        check_system_header(&bytes[..bytes.len().min(4)])?;
    }
    let path = path
        .to_str()
        .ok_or_else(|| "file link path must be UTF-8".to_owned())?
        .replace('\\', "/");
    Ok((FileLinkMetadata { path }, bytes))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target")
                .join(format!(
                    "remote-file-link-test-{}-{name}",
                    std::process::id()
                ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, name: &str, bytes: &[u8]) -> String {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_str().unwrap().to_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn params(path: &str, preview: bool) -> ReadFileLinkParams {
        ReadFileLinkParams {
            path: path.to_owned(),
            preview,
        }
    }

    #[test]
    fn reads_document_and_preview_bytes_with_canonical_utf8_paths() {
        let fixture = Fixture::new("read");
        for (name, contents, preview) in [
            (
                "报告 page.html",
                "<!doctype html><title>报告</title>",
                false,
            ),
            ("notes.md", "# 说明", true),
            ("source.rs", "fn main() {}", true),
            ("empty.py", "", true),
        ] {
            let path = fixture.write(name, contents.as_bytes());
            let (metadata, bytes) = read(params(&path, preview)).unwrap();
            assert_eq!(
                metadata.path,
                std::fs::canonicalize(&path)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/")
            );
            assert_eq!(bytes, contents.as_bytes());
        }
    }

    #[test]
    fn rejects_relative_missing_directory_and_control_character_paths() {
        let fixture = Fixture::new("invalid-path");
        for path in [
            "relative.md".to_owned(),
            fixture.0.join("missing.html").to_str().unwrap().to_owned(),
            fixture.0.to_str().unwrap().to_owned(),
            "/tmp/report\n.html".to_owned(),
            "//server/share/report.html".to_owned(),
            r"\\server\share\report.html".to_owned(),
            format!("/{}", "a".repeat(4096)),
        ] {
            assert!(read(params(&path, true)).is_err(), "{path:?}");
        }
        #[cfg(unix)]
        assert!(read(params("/dev/zero", true)).is_err());
    }

    #[test]
    fn bounds_preview_and_document_transfers_separately() {
        let fixture = Fixture::new("sizes");
        let path = fixture.write("large.md", b"a");
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_PREVIEW_BYTES).unwrap();
        assert_eq!(
            read(params(&path, true)).unwrap().1.len() as u64,
            MAX_PREVIEW_BYTES
        );
        file.set_len(MAX_PREVIEW_BYTES + 1).unwrap();
        assert!(read(params(&path, true)).is_err());
        // Larger documents may still open through the system, not in a text tab.
        assert!(read(params(&path, false)).is_ok());
        file.set_len(MAX_BINARY_PAYLOAD_BYTES as u64 + 1).unwrap();
        assert!(read(params(&path, false)).is_err());
    }

    #[test]
    fn rejects_executable_associations_and_signatures_but_allows_code_preview() {
        let fixture = Fixture::new("executables");
        for name in [
            "app.exe",
            "run.cmd",
            "shortcut.lnk",
            "sandbox.wsb",
            "image.svg",
        ] {
            let path = fixture.write(name, b"plain text");
            assert!(read(params(&path, false)).is_err(), "{name}");
        }
        let path = fixture.write("program.sh", b"#!/bin/sh\necho safe");
        assert!(read(params(&path, true)).is_ok());
        assert!(read(params(&path, false)).is_err());
        for header in [
            b"MZxx",
            b"\x7fELF",
            b"#!/x",
            &[0xfe, 0xed, 0xfa, 0xcf],
            &[0xcf, 0xfa, 0xed, 0xfe],
            &[0xca, 0xfe, 0xba, 0xbe],
        ] {
            let path = fixture.write("disguised.pdf", header);
            assert!(read(params(&path, false)).is_err(), "{header:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_executable_permissions_for_system_opens_only() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new("permissions");
        let path = fixture.write("script.txt", b"print('preview only')");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read(params(&path, false)).is_err());
        assert!(read(params(&path, true)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn validates_both_symlink_names_and_targets_and_returns_canonical_identity() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new("symlinks");
        let target = fixture.write("report.html", b"<!doctype html>");
        let link = fixture.0.join("alias.html");
        symlink(&target, &link).unwrap();
        let (metadata, _) = read(params(link.to_str().unwrap(), false)).unwrap();
        assert_eq!(
            metadata.path,
            std::fs::canonicalize(&target).unwrap().to_str().unwrap()
        );
        let bad_name = fixture.0.join("alias.wsb");
        symlink(&target, &bad_name).unwrap();
        assert!(read(params(bad_name.to_str().unwrap(), false)).is_err());
        let bad_target = fixture.write("sandbox.wsb", b"<Configuration/>");
        let disguised = fixture.0.join("disguised.html");
        symlink(bad_target, &disguised).unwrap();
        assert!(read(params(disguised.to_str().unwrap(), false)).is_err());
    }
}
