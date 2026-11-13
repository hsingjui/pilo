//! An SSH channel only owns the bridge, not the remote Pi processes.
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    time::{Instant, sleep},
};

use crate::{ServerState, cleanup, control, serve_connection};

const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
// A lost Host cannot renew the bridge or cancel a blocked tool/dialog.
const MAX_BRIDGE_ABSENCE: Duration = Duration::from_secs(60 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

fn socket_path(scope: &str) -> io::Result<PathBuf> {
    if scope.len() != 16 || !scope.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid SSH runtime scope",
        ));
    }
    let exe = std::env::current_exe()?;
    let version = crate::binary_fingerprint(&exe)?;
    use std::os::unix::fs::DirBuilderExt;
    let root = std::env::temp_dir().join(format!("pilo-{}", unsafe { libc::geteuid() }));
    match fs::DirBuilder::new().mode(0o700).create(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(&root)?;
    // A bridge can send arbitrary requests as this SSH user; never expose it to peers.
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "SSH runtime directory must be private",
        ));
    }
    Ok(root.join(format!("{scope}-{version}.sock")))
}

pub async fn bridge(scope: &str) -> io::Result<()> {
    let path = socket_path(scope)?;
    let mut socket = match UnixStream::connect(&path).await {
        Ok(socket) => socket,
        Err(error) if unavailable(&error) => {
            let mut command = Command::new(std::env::current_exe()?);
            command
                .args(["--ssh-daemon", scope])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // A new session keeps SSH channel teardown from signalling the daemon.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn()?;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match UnixStream::connect(&path).await {
                    Ok(socket) => break socket,
                    Err(error) if unavailable(&error) && Instant::now() < deadline => {
                        if let Some(status) = child.try_wait()?
                            && !status.success()
                        {
                            return Err(io::Error::other(format!("SSH daemon exited: {status}")));
                        }
                        sleep(Duration::from_millis(50)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Err(error) => return Err(error),
    };
    let (mut remote_read, mut remote_write) = socket.split();
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    tokio::select! {
        result = tokio::io::copy(&mut input, &mut remote_write) => { result?; }
        result = async {
            let mut buffer = [0; 8192];
            loop {
                let read = remote_read.read(&mut buffer).await?;
                if read == 0 {
                    return Ok::<(), io::Error>(());
                }
                output.write_all(&buffer[..read]).await?;
                output.flush().await?;
            }
        } => { result?; }
    }
    Ok(())
}

fn unavailable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}

fn lock_socket(path: &Path) -> io::Result<Option<File>> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path.with_extension("lock"))?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

pub async fn serve(scope: &str) -> io::Result<()> {
    let path = socket_path(scope)?;
    let Some(_lock) = lock_socket(&path)? else {
        return Ok(());
    };
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let state = ServerState::new(true)?;
    let control = control::listen(state.clone()).await?;
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => {
            control.abort();
            return Err(error);
        }
    };
    let mut idle_since = None;
    let mut disconnected_since = Instant::now();
    let mut replacement = None;
    let result = loop {
        if let Some(socket) = replacement.take() {
            let socket: UnixStream = socket;
            let (input, output) = socket.into_split();
            let _ = serve_connection(&state, input, output, async {
                if let Ok((socket, _)) = listener.accept().await {
                    replacement = Some(socket);
                }
            })
            .await;
            idle_since = None;
            disconnected_since = Instant::now();
            continue;
        }
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(disconnected_since + MAX_BRIDGE_ABSENCE) => break Ok(()),
            connection = listener.accept() => {
                let (socket, _) = match connection {
                    Ok(connection) => connection,
                    Err(error) => break Err(error),
                };
                replacement = Some(socket);
            }
            _ = sleep(POLL_INTERVAL) => {
                if state.request_slots.available_permits() < crate::MAX_IN_FLIGHT_REQUESTS
                    || state.control_slots.available_permits() < crate::MAX_IN_FLIGHT_REQUESTS
                    || state.pi.lock().await.values().any(crate::PiProcess::has_work)
                {
                    idle_since = None;
                } else if idle_since.get_or_insert_with(Instant::now).elapsed() >= IDLE_TIMEOUT {
                    // Close admission before cleaning up children.
                    break Ok(());
                }
            }
        }
    };
    drop(listener);
    let _ = fs::remove_file(&path);
    control.abort();
    cleanup(state).await;
    result
}
