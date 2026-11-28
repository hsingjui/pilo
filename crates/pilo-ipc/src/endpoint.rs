//! Host and CLI derive the same endpoint from the App ID; there is no discovery file.
//!
//! - macOS: `~/Library/Application Support/<app id>/pilo.sock`
//! - Linux: `$XDG_RUNTIME_DIR/pilo/<app id>.sock`
//! - Either, when the path exceeds [`MAX_UNIX_PATH_BYTES`] or Linux has no
//!   `XDG_RUNTIME_DIR`: `/tmp/pilo-<uid>/<app id>.sock`
//! - Windows: `\\.\pipe\pilo-<app id>-<user SID>`

use std::path::{Path, PathBuf};

/// macOS `sun_path` holds 104 bytes; keep a margin for the terminator.
pub const MAX_UNIX_PATH_BYTES: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Unix(UnixEndpoint),
    NamedPipe(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnixEndpoint {
    pub path: PathBuf,
    /// A directory the Host creates with mode `0700` and must verify is owned
    /// by the current user and not a symbolic link. `None` for the App data
    /// directory, which the Host already owns.
    pub private_dir: Option<PathBuf>,
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unix(endpoint) => write!(f, "{}", endpoint.path.display()),
            Self::NamedPipe(name) => f.write_str(name),
        }
    }
}

/// App IDs become path and pipe-name components, so keep them to a reverse-DNS alphabet.
pub fn validate_app_id(app_id: &str) -> Result<(), String> {
    let valid = !app_id.is_empty()
        && app_id.len() <= 128
        && !app_id.starts_with('.')
        && !app_id.contains("..")
        && app_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(format!("invalid Pilo App ID '{app_id}'"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnixPlatform {
    MacOs,
    Linux,
}

/// The pure Unix derivation rule; [`Endpoint::current`] supplies the environment.
pub fn derive_unix(
    platform: UnixPlatform,
    app_id: &str,
    home: Option<&Path>,
    xdg_runtime_dir: Option<&Path>,
    uid: u32,
) -> Result<UnixEndpoint, String> {
    validate_app_id(app_id)?;
    let preferred = match platform {
        UnixPlatform::MacOs => home
            .filter(|home| home.is_absolute())
            .map(|home| UnixEndpoint {
                path: home
                    .join("Library/Application Support")
                    .join(app_id)
                    .join("pilo.sock"),
                private_dir: None,
            }),
        UnixPlatform::Linux => xdg_runtime_dir.filter(|dir| dir.is_absolute()).map(|dir| {
            let private_dir = dir.join("pilo");
            UnixEndpoint {
                path: private_dir.join(format!("{app_id}.sock")),
                private_dir: Some(private_dir),
            }
        }),
    };
    if let Some(endpoint) = preferred
        && endpoint.path.as_os_str().len() <= MAX_UNIX_PATH_BYTES
    {
        return Ok(endpoint);
    }
    let private_dir = PathBuf::from(format!("/tmp/pilo-{uid}"));
    let path = private_dir.join(format!("{app_id}.sock"));
    if path.as_os_str().len() > MAX_UNIX_PATH_BYTES {
        return Err(format!("Pilo IPC path for '{app_id}' is too long"));
    }
    Ok(UnixEndpoint {
        path,
        private_dir: Some(private_dir),
    })
}

pub fn pipe_name(app_id: &str, user_sid: &str) -> Result<String, String> {
    validate_app_id(app_id)?;
    Ok(format!(r"\\.\pipe\pilo-{app_id}-{user_sid}"))
}

impl Endpoint {
    /// The endpoint for `app_id` and the current OS user.
    pub fn current(app_id: &str) -> Result<Self, String> {
        #[cfg(unix)]
        {
            let platform = if cfg!(target_os = "macos") {
                UnixPlatform::MacOs
            } else {
                UnixPlatform::Linux
            };
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
            derive_unix(
                platform,
                app_id,
                home.as_deref(),
                runtime_dir.as_deref(),
                current_uid(),
            )
            .map(Self::Unix)
        }
        #[cfg(windows)]
        {
            pipe_name(app_id, &windows::current_user_sid()?).map(Self::NamedPipe)
        }
    }
}

#[cfg(unix)]
pub fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

#[cfg(windows)]
pub mod windows {
    //! Current-user SID helpers for the named pipe name and its ACL.

    use std::ptr;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW, EqualSid, GetTokenInformation, TOKEN_QUERY,
            TOKEN_USER, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    /// Reads the token user of `token` and compares or formats it.
    pub struct TokenSid(Vec<u8>);

    impl TokenSid {
        /// # Safety
        ///
        /// `token` must be a valid access token handle opened with `TOKEN_QUERY`.
        pub unsafe fn of_token(token: HANDLE) -> Result<Self, String> {
            let mut length = 0_u32;
            // SAFETY: a null buffer queries the required length.
            unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length) };
            if length == 0 {
                return Err("failed to query the Windows user".to_owned());
            }
            let mut buffer = vec![0_u8; length as usize];
            // SAFETY: the buffer has the requested length.
            let ok = unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    length,
                    &mut length,
                )
            };
            if ok == 0 {
                return Err("failed to read the Windows user".to_owned());
            }
            Ok(Self(buffer))
        }

        pub fn current() -> Result<Self, String> {
            let mut token: HANDLE = ptr::null_mut();
            // SAFETY: the pseudo handle of the current process is always valid.
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err("failed to open the current Windows process token".to_owned());
            }
            // SAFETY: the token was opened with TOKEN_QUERY above.
            let sid = unsafe { Self::of_token(token) };
            // SAFETY: the token was opened above.
            unsafe { CloseHandle(token) };
            sid
        }

        fn sid(&self) -> *mut core::ffi::c_void {
            // SAFETY: the buffer holds a TOKEN_USER written by GetTokenInformation.
            unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
        }

        pub fn same_user(&self, other: &Self) -> bool {
            // SAFETY: both SIDs point into live TOKEN_USER buffers.
            unsafe { EqualSid(self.sid(), other.sid()) != 0 }
        }

        pub fn to_string_sid(&self) -> Result<String, String> {
            let mut text: *mut u16 = ptr::null_mut();
            // SAFETY: the SID is valid; the output is freed with LocalFree.
            if unsafe { ConvertSidToStringSidW(self.sid(), &mut text) } == 0 {
                return Err("failed to format the Windows user SID".to_owned());
            }
            // SAFETY: ConvertSidToStringSidW returns a NUL-terminated string.
            let length = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
            let value =
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
            unsafe { LocalFree(text.cast()) };
            Ok(value)
        }
    }

    pub fn current_user_sid() -> Result<String, String> {
        TokenSid::current()?.to_string_sid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_uses_the_app_data_directory() {
        let endpoint = derive_unix(
            UnixPlatform::MacOs,
            "app.hsingjui.pilo",
            Some(Path::new("/Users/me")),
            None,
            501,
        )
        .unwrap();
        assert_eq!(
            endpoint.path,
            Path::new("/Users/me/Library/Application Support/app.hsingjui.pilo/pilo.sock")
        );
        assert_eq!(endpoint.private_dir, None);
    }

    #[test]
    fn linux_uses_the_runtime_directory_or_a_private_tmp_directory() {
        let endpoint = derive_unix(
            UnixPlatform::Linux,
            "app.hsingjui.pilo.dev",
            Some(Path::new("/home/me")),
            Some(Path::new("/run/user/1000")),
            1000,
        )
        .unwrap();
        assert_eq!(
            endpoint.path,
            Path::new("/run/user/1000/pilo/app.hsingjui.pilo.dev.sock")
        );
        assert_eq!(
            endpoint.private_dir.unwrap(),
            Path::new("/run/user/1000/pilo")
        );
        for runtime_dir in [None, Some(Path::new("relative"))] {
            let endpoint = derive_unix(
                UnixPlatform::Linux,
                "app.hsingjui.pilo",
                Some(Path::new("/home/me")),
                runtime_dir,
                1000,
            )
            .unwrap();
            assert_eq!(
                endpoint.path,
                Path::new("/tmp/pilo-1000/app.hsingjui.pilo.sock")
            );
            assert_eq!(endpoint.private_dir.unwrap(), Path::new("/tmp/pilo-1000"));
        }
    }

    #[test]
    fn long_paths_fall_back_at_the_100_byte_boundary() {
        let suffix = "/Library/Application Support/app.hsingjui.pilo/pilo.sock";
        let home_for = |total: usize| format!("/{}", "h".repeat(total - suffix.len() - 1));
        let exact = home_for(MAX_UNIX_PATH_BYTES);
        let endpoint = derive_unix(
            UnixPlatform::MacOs,
            "app.hsingjui.pilo",
            Some(Path::new(&exact)),
            None,
            501,
        )
        .unwrap();
        assert_eq!(endpoint.path.as_os_str().len(), MAX_UNIX_PATH_BYTES);
        assert!(endpoint.path.starts_with(&exact));

        let over = home_for(MAX_UNIX_PATH_BYTES + 1);
        let endpoint = derive_unix(
            UnixPlatform::MacOs,
            "app.hsingjui.pilo",
            Some(Path::new(&over)),
            None,
            501,
        )
        .unwrap();
        assert_eq!(
            endpoint.path,
            Path::new("/tmp/pilo-501/app.hsingjui.pilo.sock")
        );
    }

    #[test]
    fn release_and_dev_never_share_an_endpoint() {
        let derive = |app_id| {
            derive_unix(UnixPlatform::Linux, app_id, None, None, 7).map(|endpoint| endpoint.path)
        };
        assert_ne!(
            derive(crate::RELEASE_APP_ID).unwrap(),
            derive(crate::DEV_APP_ID).unwrap()
        );
        assert_eq!(
            pipe_name(crate::DEV_APP_ID, "S-1-5-21-1").unwrap(),
            r"\\.\pipe\pilo-app.hsingjui.pilo.dev-S-1-5-21-1"
        );
    }

    #[test]
    fn rejects_app_ids_that_could_escape_the_directory() {
        for app_id in ["", "../x", "a/b", ".hidden", "a..b", "a b", "a\\b"] {
            assert!(validate_app_id(app_id).is_err(), "{app_id}");
        }
        assert!(validate_app_id("app.hsingjui.pilo-dev_1").is_ok());
    }
}
