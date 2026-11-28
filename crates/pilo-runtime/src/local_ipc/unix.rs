use std::{
    io,
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

use pilo_ipc::{UnixEndpoint, endpoint::current_uid};
use tokio::{net::UnixListener, sync::watch, task::JoinHandle};

use super::{DRAIN_TIMEOUT, Shared, serve, wait_stopped};

pub(super) fn listen(
    endpoint: &UnixEndpoint,
    shared: Arc<Shared>,
    mut stopped: watch::Receiver<bool>,
) -> Result<JoinHandle<()>, String> {
    let uid = current_uid();
    match &endpoint.private_dir {
        Some(dir) => prepare_private_dir(dir, uid)?,
        None => {
            if let Some(parent) = endpoint.path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
            }
        }
    }
    let path = endpoint.path.clone();
    reclaim_stale_socket(&path, uid)?;
    let listener = UnixListener::bind(&path)
        .map_err(|error| format!("failed to bind {}: {error}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to restrict {}: {error}", path.display()))?;
    let bound = std::fs::symlink_metadata(&path)
        .map(|metadata| (metadata.dev(), metadata.ino()))
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    Ok(tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = wait_stopped(&mut stopped) => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    match stream.peer_cred() {
                        Ok(credentials) if credentials.uid() == uid => {}
                        Ok(credentials) => {
                            log::warn!(target: "local-ipc", "rejected peer uid {}", credentials.uid());
                            continue;
                        }
                        Err(error) => {
                            log::warn!(target: "local-ipc", "rejected peer without credentials: {error}");
                            continue;
                        }
                    }
                    let shared = shared.clone();
                    connections.spawn(async move {
                        let Ok(_permit) = shared.connections.acquire().await else { return };
                        serve(stream, Arc::clone(&shared)).await;
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        drop(listener);
        remove_if_bound(&path, bound);
        let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
            while connections.join_next().await.is_some() {}
        })
        .await;
        connections.abort_all();
    }))
}

/// Creates the fallback or runtime subdirectory as `0700`, and refuses one that
/// another user owns or that is a symbolic link.
fn prepare_private_dir(dir: &Path, uid: u32) -> Result<(), String> {
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("failed to create {}: {error}", dir.display())),
    }
    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|error| format!("failed to inspect {}: {error}", dir.display()))?;
    if !metadata.file_type().is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    if metadata.uid() != uid {
        return Err(format!("{} is owned by another user", dir.display()));
    }
    if metadata.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to restrict {}: {error}", dir.display()))?;
    }
    Ok(())
}

/// Removes an existing endpoint only when it is this user's socket and nobody
/// accepts connections on it; a live or foreign endpoint is left untouched.
fn reclaim_stale_socket(path: &PathBuf, uid: u32) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect {}: {error}", path.display())),
    };
    if !metadata.file_type().is_socket() || metadata.uid() != uid {
        return Err(format!(
            "{} exists and is not this user's Pilo socket",
            path.display()
        ));
    }
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => Err(format!(
            "another Pilo instance is already listening on {}",
            path.display()
        )),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            std::fs::remove_file(path)
                .map_err(|error| format!("failed to remove stale {}: {error}", path.display()))
        }
        Err(error) => Err(format!(
            "could not verify the existing {}: {error}",
            path.display()
        )),
    }
}

fn remove_if_bound(path: &Path, bound: (u64, u64)) {
    if std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) == bound)
    {
        let _ = std::fs::remove_file(path);
    }
}
