use nsh_core::{open_url as url_policy, prelude::*};

/// Opens project links in the editors supported by the desktop quick-open menu.
#[module]
pub(crate) struct DesktopEditorLinks;

#[module]
impl DesktopEditorLinks {
    /// Opens a Zed, VS Code, or Cursor URL with its registered handler.
    pub async fn open(url: String, sys: System) -> Result<bool, JsError> {
        url_policy::check_url(&url).map_err(JsError::Type)?;
        if !matches!(
            url.split_once("://"),
            Some(("zed" | "vscode" | "cursor", _))
        ) {
            return Err(JsError::Type("expected a project editor URL".into()));
        }
        if !sys.access.allows_open_url(&url) {
            return Err(url_policy::not_granted(&url));
        }

        #[cfg(windows)]
        {
            // nsh 0.7.0 opens URLs during a mount batch. ShellExecute can dispatch
            // window messages and reenter the mounter while it is borrowed.
            let (tx, rx) = tokio::sync::oneshot::channel();
            std::thread::Builder::new()
                .name("pilo-editor-open".into())
                .spawn(move || {
                    let _ = tx.send(open_on_windows(&url));
                })
                .map_err(|error| {
                    JsError::Error(format!("could not start editor launcher: {error}"))
                })?;
            rx.await
                .map_err(|_| JsError::Error("editor launcher stopped unexpectedly".into()))?
                .map(|()| true)
                .map_err(JsError::Error)
        }
        #[cfg(not(windows))]
        {
            Ok(open_url(url).await)
        }
    }
}

#[cfg(windows)]
fn open_on_windows(url: &str) -> Result<(), String> {
    use std::{io::Error, mem::size_of, ptr};
    use windows_sys::{
        Win32::{
            System::Com::{
                COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
            },
            UI::{
                Shell::{
                    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
        w,
    };

    let url: Vec<u16> = url.encode_utf16().chain([0]).collect();
    let mut request = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
        lpVerb: w!("open"),
        lpFile: url.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    // SAFETY: This fresh worker owns COM for the duration of the call, both
    // strings are NUL-terminated and live through it, and no HWND is passed.
    unsafe {
        let status = CoInitializeEx(
            ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        );
        if status < 0 {
            return Err(format!(
                "could not initialize editor launcher: {status:#010x}"
            ));
        }
        let opened = ShellExecuteExW(&mut request);
        let error = (opened == 0).then(Error::last_os_error);
        CoUninitialize();
        match error {
            None => Ok(()),
            Some(error) => Err(format!("could not open editor URL: {error}")),
        }
    }
}
