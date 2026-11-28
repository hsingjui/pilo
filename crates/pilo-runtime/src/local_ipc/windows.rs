use std::{ptr, sync::Arc};

use pilo_ipc::endpoint::windows::TokenSid;
use tokio::{
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::watch,
    task::JoinHandle,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    },
    System::{
        Pipes::GetNamedPipeClientProcessId,
        Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

use super::{DRAIN_TIMEOUT, Shared, serve, wait_stopped};

/// A security descriptor granting only the current user access.
struct UserOnlyDescriptor(PSECURITY_DESCRIPTOR);

unsafe impl Send for UserOnlyDescriptor {}
unsafe impl Sync for UserOnlyDescriptor {}

impl UserOnlyDescriptor {
    fn new(sid: &str) -> Result<Self, String> {
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: the SDDL string is NUL-terminated; the output is freed in Drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err("failed to build the Pilo pipe ACL".to_owned());
        }
        Ok(Self(descriptor))
    }

    fn create(&self, name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        };
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true);
        // SAFETY: the attributes and descriptor outlive this call.
        unsafe {
            options.create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
        }
    }
}

impl Drop for UserOnlyDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0) };
    }
}

pub(super) fn listen(
    name: &str,
    shared: Arc<Shared>,
    mut stopped: watch::Receiver<bool>,
) -> Result<JoinHandle<()>, String> {
    let user = TokenSid::current()?;
    let descriptor = UserOnlyDescriptor::new(&user.to_string_sid()?)?;
    // first_pipe_instance fails if another process (or Pilo instance) owns the name.
    let mut server = descriptor
        .create(name, true)
        .map_err(|error| format!("failed to create pipe {name}: {error}"))?;
    let name = name.to_owned();
    Ok(tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = wait_stopped(&mut stopped) => break,
                connected = server.connect() => {
                    if connected.is_err() {
                        continue;
                    }
                    let next = match descriptor.create(&name, false) {
                        Ok(next) => next,
                        Err(error) => {
                            log::warn!(target: "local-ipc", "failed to create the next pipe instance: {error}");
                            break;
                        }
                    };
                    let stream = std::mem::replace(&mut server, next);
                    if !same_user(&stream, &user) {
                        log::warn!(target: "local-ipc", "rejected a pipe client of another user");
                        continue;
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
        drop(server);
        let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
            while connections.join_next().await.is_some() {}
        })
        .await;
        connections.abort_all();
    }))
}

fn same_user(stream: &NamedPipeServer, user: &TokenSid) -> bool {
    use std::os::windows::io::AsRawHandle;
    let mut pid = 0_u32;
    // SAFETY: the pipe handle is connected and owned by `stream`.
    if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle() as HANDLE, &mut pid) } == 0 {
        return false;
    }
    // SAFETY: the process handle is closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `process` is a valid handle.
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } != 0;
    unsafe { CloseHandle(process) };
    if !opened {
        return false;
    }
    // SAFETY: the token was opened with TOKEN_QUERY above.
    let peer = unsafe { TokenSid::of_token(token) };
    unsafe { CloseHandle(token) };
    peer.is_ok_and(|peer| peer.same_user(user))
}
