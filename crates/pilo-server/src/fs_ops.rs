use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use pilo_protocol::{FsEntry, FsEntryKind, MAX_BINARY_PAYLOAD_BYTES};
use serde::Deserialize;
use serde_json::Value;

use crate::to_value;

#[derive(Deserialize)]
pub(crate) struct FsPathParams {
    pub(crate) project: String,
    pub(crate) path: String,
}
#[derive(Deserialize)]
pub(crate) struct FsWriteParams {
    pub(crate) project: String,
    pub(crate) path: String,
}
#[derive(Deserialize)]
pub(crate) struct FsRenameParams {
    pub(crate) project: String,
    pub(crate) from: String,
    pub(crate) to: String,
}
#[derive(Deserialize)]
pub(crate) struct FsSearchParams {
    pub(crate) project: String,
    pub(crate) query: String,
}

#[derive(Deserialize)]
pub(crate) struct AbsolutePathParams {
    pub(crate) path: String,
}

fn canonical_project(project: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(project)
        .map_err(|error| format!("project '{project}' is not accessible: {error}"))?;
    if !root.is_dir() {
        return Err(format!("project '{project}' is not a directory"));
    }
    Ok(root)
}

fn relative_project_path(relative: &str, allow_root: bool) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("path must stay inside the project".to_owned());
    }
    if relative.as_os_str().is_empty() && !allow_root {
        return Err("project root is not valid for this operation".to_owned());
    }
    Ok(relative.to_path_buf())
}

fn ensure_inside_project(root: &Path, path: &Path) -> Result<(), String> {
    if path == root || path.starts_with(root) {
        Ok(())
    } else {
        Err("path resolves outside the project".to_owned())
    }
}

pub(crate) fn checked_existing_path(
    project: &str,
    relative: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_project(project)?;
    let relative = relative_project_path(relative, allow_root)?;
    let path = root
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("path '{}' is not accessible: {error}", relative.display()))?;
    ensure_inside_project(&root, &path)?;
    Ok((root, path))
}

fn checked_entry_path(
    project: &str,
    relative: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_project(project)?;
    let relative = relative_project_path(relative, allow_root)?;
    let candidate = root.join(relative);
    if candidate == root {
        return Ok((root.clone(), root));
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "path has no parent directory".to_owned())?
        .canonicalize()
        .map_err(|error| format!("path parent is not accessible: {error}"))?;
    ensure_inside_project(&root, &parent)?;
    let name = candidate
        .file_name()
        .ok_or_else(|| "path has no file name".to_owned())?;
    Ok((root, parent.join(name)))
}

pub(crate) fn checked_mutation_path(
    project: &str,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_project(project)?;
    let relative = relative_project_path(relative, false)?;
    let candidate = root.join(relative);
    if std::fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("mutating a symlink path is not allowed".to_owned());
    }

    let ancestor = candidate
        .ancestors()
        .find(|path| path.exists())
        .ok_or_else(|| "path has no accessible parent directory".to_owned())?;
    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| format!("path parent is not accessible: {error}"))?;
    ensure_inside_project(&root, &canonical_ancestor)?;
    let suffix = candidate
        .strip_prefix(ancestor)
        .map_err(|error| error.to_string())?;
    Ok((root, canonical_ancestor.join(suffix)))
}

fn fs_entry(project: &Path, path: &Path) -> Result<FsEntry, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        FsEntryKind::Symlink
    } else if file_type.is_dir() {
        FsEntryKind::Directory
    } else if file_type.is_file() {
        FsEntryKind::File
    } else {
        FsEntryKind::Other
    };
    let relative = path
        .strip_prefix(project)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned();
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            project
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64);
    Ok(FsEntry {
        path: relative,
        name,
        kind,
        size: metadata.len(),
        modified_at_ms,
    })
}

pub(crate) fn fs_read_dir(params: FsPathParams) -> Result<Value, String> {
    let (project_root, root) = checked_existing_path(&params.project, &params.path, true)?;
    let mut entries = std::fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            let entry = entry.map_err(|error| error.to_string())?;
            fs_entry(&project_root, &entry.path())
        })
        .collect::<Result<Vec<_>, String>>()?;
    entries.sort_by(|a, b| {
        (
            (a.kind != FsEntryKind::Directory) as u8,
            a.name.to_lowercase(),
        )
            .cmp(&(
                (b.kind != FsEntryKind::Directory) as u8,
                b.name.to_lowercase(),
            ))
    });
    to_value(entries)
}

pub(crate) fn fs_read_file(params: FsPathParams) -> Result<Vec<u8>, String> {
    let (_, path) = checked_existing_path(&params.project, &params.path, false)?;
    let size = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_BINARY_PAYLOAD_BYTES as u64 {
        return Err(format!(
            "file '{}' is {size} bytes; pilo-server read limit is {} bytes",
            params.path, MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    std::fs::read(path).map_err(|error| error.to_string())
}
pub(crate) fn fs_write_file(params: FsWriteParams, data: Vec<u8>) -> Result<Value, String> {
    if data.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "file write is {} bytes; pilo-server limit is {} bytes",
            data.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    let (_, path) = checked_mutation_path(&params.project, &params.path)?;
    std::fs::write(path, data).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
pub(crate) fn fs_stat(params: FsPathParams) -> Result<Value, String> {
    let (project_root, path) = checked_entry_path(&params.project, &params.path, true)?;
    to_value(fs_entry(&project_root, &path)?)
}
pub(crate) fn fs_mkdir(params: FsPathParams) -> Result<Value, String> {
    let (_, path) = checked_mutation_path(&params.project, &params.path)?;
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) fn fs_mkdir_absolute(params: AbsolutePathParams) -> Result<Value, String> {
    let path = PathBuf::from(&params.path);
    if !path.is_absolute() {
        return Err("absolute path is required".to_owned());
    }
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) fn fs_rename(params: FsRenameParams) -> Result<Value, String> {
    let (_, from) = checked_entry_path(&params.project, &params.from, false)?;
    let (_, to) = checked_mutation_path(&params.project, &params.to)?;
    std::fs::rename(from, to).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
pub(crate) fn fs_remove(params: FsPathParams) -> Result<Value, String> {
    let (_, path) = checked_entry_path(&params.project, &params.path, false)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) fn fs_search(params: FsSearchParams) -> Result<Value, String> {
    fn visit(
        root: &Path,
        current: &Path,
        query: &str,
        result: &mut Vec<String>,
    ) -> Result<(), String> {
        if result.len() >= 200 {
            return Ok(());
        }
        for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                    continue;
                }
                visit(root, &path, query, result)?;
            } else if file_type.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative.to_lowercase().contains(query) {
                    result.push(relative);
                }
            }
        }
        Ok(())
    }
    let root = canonical_project(&params.project)?;
    let mut result = Vec::new();
    visit(
        &root,
        &root,
        &params.query.trim().to_lowercase(),
        &mut result,
    )?;
    to_value(result)
}
