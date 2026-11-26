//! Native macOS development fallback for desktop notifications.
//!
//! `nsh`'s built-in `Notifications` module uses `UNUserNotificationCenter`,
//! which requires a macOS `.app` bundle with a `CFBundleIdentifier` and
//! returns `unavailable` under `nsh dev` (an unpackaged host executable).
//! This module bridges `mac-notification-sys` only for unpackaged macOS debug
//! builds so packaged `.app` builds stay on `nsh`'s `UNUserNotificationCenter`
//! without any `NSBundle` swizzling.

use std::{
    collections::VecDeque,
    path::Path,
    sync::{Mutex, OnceLock, PoisonError},
};

use nsh_core::prelude::*;
use tokio::sync::oneshot;

const MAX_QUEUED_PRESSES: usize = 64;

struct PressQueueState {
    queued: VecDeque<String>,
    waiter: Option<oneshot::Sender<Option<String>>>,
}

struct PressQueue {
    state: Mutex<PressQueueState>,
}

impl PressQueue {
    const fn new() -> Self {
        Self {
            state: Mutex::new(PressQueueState {
                queued: VecDeque::new(),
                waiter: None,
            }),
        }
    }

    #[cfg_attr(not(all(target_os = "macos", debug_assertions)), allow(dead_code))]
    fn push(&self, id: String) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(waiter) = state.waiter.take()
            && waiter.send(Some(id.clone())).is_ok()
        {
            return;
        }
        if state.queued.len() >= MAX_QUEUED_PRESSES {
            state.queued.pop_front();
        }
        state.queued.push_back(id);
    }

    async fn next(&self) -> Option<String> {
        let receiver = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(id) = state.queued.pop_front() {
                return Some(id);
            }
            let (tx, rx) = oneshot::channel();
            // Hot reload replaces the JS VM in the same native host process;
            // wake any previous listener so it exits instead of deadlocking.
            if let Some(previous) = state.waiter.replace(tx) {
                let _ = previous.send(None);
            }
            rx
        };
        receiver.await.ok().flatten()
    }

    fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(waiter) = state.waiter.take() {
            let _ = waiter.send(None);
        }
    }
}

static PRESS_QUEUE: PressQueue = PressQueue::new();

/// Whether `exe` lives inside a macOS `.app` bundle (`*.app/Contents/MacOS/<bin>`)
/// with an `Info.plist`. Checked via filesystem structure rather than `NSBundle`
/// so swizzling `bundleIdentifier` can never alter this answer.
fn has_macos_app_bundle(exe: &Path) -> bool {
    let Some(macos_dir) = exe.parent() else {
        return false;
    };
    if macos_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return false;
    }
    let Some(contents_dir) = macos_dir.parent() else {
        return false;
    };
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return false;
    }
    let Some(bundle_dir) = contents_dir.parent() else {
        return false;
    };
    bundle_dir.extension().and_then(|ext| ext.to_str()) == Some("app")
        && contents_dir.join("Info.plist").is_file()
}

#[cfg(all(target_os = "macos", debug_assertions))]
mod macos_dev {
    use super::*;
    use mac_notification_sys::{Notification, NotificationResponse};

    const DEV_NOTIFICATION_BUNDLE_ID: &str = "com.apple.Terminal";

    fn ensure_application() -> Result<(), String> {
        static INIT: OnceLock<Result<(), String>> = OnceLock::new();
        INIT.get_or_init(|| {
            mac_notification_sys::set_application(DEV_NOTIFICATION_BUNDLE_ID).map_err(|error| {
                format!(
                    "failed to register macOS notification application '{DEV_NOTIFICATION_BUNDLE_ID}': {error}"
                )
            })
        })
        .clone()
    }

    fn dev_icon_path() -> Option<String> {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest_dir
            .ancestors()
            .find(|dir| dir.join("Cargo.toml").is_file() && dir.join("nsh.json").is_file())?;
        let candidates = [
            workspace.join("app/assets/app-icon-macos.png"),
            workspace.join("app/assets/app-icon.png"),
        ];
        candidates
            .into_iter()
            .find(|path| path.is_file())
            .and_then(|path| path.to_str().map(str::to_owned))
    }

    pub(super) async fn show(
        id: String,
        title: String,
        body: String,
        wait_for_click: bool,
    ) -> Result<bool, String> {
        if let Err(error) = ensure_application() {
            log::error!(target: "notification", "{error}");
            return Ok(false);
        }
        let icon_path = dev_icon_path();
        if wait_for_click {
            std::thread::Builder::new()
                .name("pilo-notification".to_owned())
                .spawn(move || {
                    let mut notification = Notification::new();
                    notification
                        .title(&title)
                        .message(&body)
                        .default_sound()
                        .wait_for_click(true);
                    if let Some(icon) = icon_path.as_deref() {
                        notification.app_icon(icon);
                    }
                    match notification.send() {
                        Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) => {
                            PRESS_QUEUE.push(id);
                        }
                        Ok(_) => {}
                        Err(error) => {
                            log::error!(
                                target: "notification",
                                "failed to show macOS dev notification: {error}"
                            );
                        }
                    }
                })
                .map_err(|error| format!("failed to spawn macOS notification thread: {error}"))?;
            return Ok(true);
        }

        let (tx, rx) = oneshot::channel();
        std::thread::Builder::new()
            .name("pilo-notification".to_owned())
            .spawn(move || {
                let mut notification = Notification::new();
                notification
                    .title(&title)
                    .message(&body)
                    .default_sound()
                    .asynchronous(true);
                if let Some(icon) = icon_path.as_deref() {
                    notification.app_icon(icon);
                }
                let sent = match notification.send() {
                    Ok(_) => true,
                    Err(error) => {
                        log::error!(
                            target: "notification",
                            "failed to show macOS dev notification: {error}"
                        );
                        false
                    }
                };
                let _ = tx.send(sent);
            })
            .map_err(|error| format!("failed to spawn macOS notification thread: {error}"))?;
        Ok(rx.await.unwrap_or(false))
    }
}

fn current_exe_has_macos_bundle() -> bool {
    static HAS_BUNDLE: OnceLock<bool> = OnceLock::new();
    *HAS_BUNDLE.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .map(|exe| has_macos_app_bundle(&exe))
            .unwrap_or(false)
    })
}

/// Native fallback for desktop notifications when the host is an unpackaged
/// macOS development executable.
#[module]
pub struct DesktopNotifications;

#[module]
impl DesktopNotifications {
    /// Whether this process should use the macOS development fallback instead
    /// of `nsh`'s `Notifications` (`UNUserNotificationCenter`).
    pub fn is_fallback_available() -> bool {
        cfg!(all(target_os = "macos", debug_assertions)) && !current_exe_has_macos_bundle()
    }

    /// Shows a notification through the macOS development fallback.
    pub async fn show(
        id: String,
        title: String,
        body: String,
        wait_for_click: bool,
    ) -> Result<bool, String> {
        if id.is_empty() || title.is_empty() {
            return Err("notification `id` and `title` must not be empty".to_owned());
        }
        if !Self::is_fallback_available() {
            return Ok(false);
        }
        #[cfg(all(target_os = "macos", debug_assertions))]
        {
            macos_dev::show(id, title, body, wait_for_click).await
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        {
            let _ = (id, title, body, wait_for_click);
            Ok(false)
        }
    }

    /// Waits for the next clicked fallback notification identifier, or `null`
    /// when superseded by a newer listener or stopped.
    pub async fn next_press() -> Option<String> {
        if !Self::is_fallback_available() {
            return None;
        }
        PRESS_QUEUE.next().await
    }

    /// Stops any active `nextPress` wait without discarding queued presses.
    pub fn stop_press_listener() {
        PRESS_QUEUE.stop();
    }
}

#[cfg(windows)]
pub(crate) fn init_windows_notifications() {
    windows_shortcut::init();
}

#[cfg(windows)]
mod windows_shortcut {
    use std::{
        ffi::c_void,
        path::{Path, PathBuf},
        ptr,
        sync::Once,
    };

    use windows::{
        Win32::{
            Storage::EnhancedStorage::{
                PKEY_AppUserModel_ID, PKEY_AppUserModel_ToastActivatorCLSID,
            },
            System::{
                Com::{
                    CLSCTX_INPROC_SERVER, CLSIDFromString, COINIT_APARTMENTTHREADED,
                    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                    STGM_READWRITE,
                    StructuredStorage::{
                        InitPropVariantFromCLSID, PropVariantToGUID, PropVariantToStringAlloc,
                    },
                },
                Registry::{
                    HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegGetValueW, RegSetKeyValueW,
                },
            },
            UI::Shell::{
                FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Programs,
                FOLDERID_PublicDesktop, IShellLinkW, KF_FLAG_DEFAULT,
                PropertiesSystem::IPropertyStore, SHCNE_UPDATEITEM, SHCNF_PATHW, SHChangeNotify,
                SHGetKnownFolderPath, ShellLink,
            },
        },
        core::{GUID, HSTRING, Interface, PCWSTR, PWSTR, Result},
    };

    const APP_USER_MODEL_ID: &str = "app.hsingjui.pilo";
    const DEV_APP_USER_MODEL_ID: &str = "app.hsingjui.pilo.dev";
    const SHORTCUT_FILE_NAME: &str = "Pilo.lnk";
    const TOAST_ACTIVATED_ARG: &str = "-ToastActivated";

    struct ComApartment(bool);

    impl ComApartment {
        fn init() -> Result<Self> {
            // SAFETY: Initializes an STA on the dedicated worker/test thread.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            hr.ok()?;
            Ok(Self(true))
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: Balances the successful `CoInitializeEx` on this thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Computes the same deterministic COM CLSID that `nsh-platform-windows`
    /// registers under `HKCU\Software\Classes\AppUserModelId\<id>\CustomActivator`.
    pub(super) fn nsh_toast_activator_clsid(app_id: &str) -> GUID {
        const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013B;
        const BASIS: u128 = 0x6C62_272E_07BB_0142_62B8_2175_6295_C58D;
        let hash = format!("nsh.notifications:{app_id}")
            .bytes()
            .fold(BASIS, |acc, byte| {
                (acc ^ u128::from(byte)).wrapping_mul(PRIME)
            });
        let bits =
            (hash & !(0xF_u128 << 76) & !(0x3_u128 << 62)) | (0x4_u128 << 76) | (0x2_u128 << 62);
        GUID::from_u128(bits)
    }

    /// Formats `clsid` in the braced uppercase form Windows Registry expects.
    pub(super) fn format_clsid_braced(clsid: &GUID) -> String {
        let bits = clsid.to_u128();
        format!(
            "{{{:08X}-{:04X}-{:04X}-{:04X}-{:012X}}}",
            (bits >> 96) as u32,
            (bits >> 80) as u16,
            (bits >> 64) as u16,
            (bits >> 48) as u16,
            bits & 0xFFFF_FFFF_FFFF,
        )
    }

    fn read_hkcu_string(subkey: &str, value_name: Option<&str>) -> Option<String> {
        let key = HSTRING::from(subkey);
        let value = value_name.map(HSTRING::from);
        let value_ptr = value
            .as_ref()
            .map_or(PCWSTR::null(), |v| PCWSTR(v.as_ptr()));
        let mut bytes = 0_u32;
        // SAFETY: Queries required buffer size for a `REG_SZ` value under HKCU.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &key,
                value_ptr,
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut bytes),
            )
        };
        if status.is_err() || bytes < 2 {
            return None;
        }
        let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2)];
        // SAFETY: `buffer` has at least `bytes` bytes of writable storage.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &key,
                value_ptr,
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast::<c_void>()),
                Some(&mut bytes),
            )
        };
        if status.is_err() {
            return None;
        }
        let end = buffer
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..end]);
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    }

    fn write_hkcu_string(subkey: &str, value_name: Option<&str>, data: &str) -> Result<()> {
        let wide: Vec<u16> = data.encode_utf16().chain(Some(0)).collect();
        let key = HSTRING::from(subkey);
        let value = value_name.map(HSTRING::from);
        let value_ptr = value
            .as_ref()
            .map_or(PCWSTR::null(), |v| PCWSTR(v.as_ptr()));
        // SAFETY: `key`, `value_ptr`, and `wide` are valid NUL-terminated UTF-16 strings.
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &key,
                value_ptr,
                REG_SZ.0,
                Some(wide.as_ptr().cast::<c_void>()),
                (wide.len() * 2) as u32,
            )
        }
        .ok()
    }

    /// Prefers the `CustomActivator` written by `nsh-platform-windows`, falling
    /// back to its deterministic CLSID when notifications have not registered yet.
    fn expected_toast_activator_clsid(app_id: &str) -> GUID {
        registered_custom_activator(app_id).unwrap_or_else(|| nsh_toast_activator_clsid(app_id))
    }

    fn registered_custom_activator(app_id: &str) -> Option<GUID> {
        let subkey = format!("Software\\Classes\\AppUserModelId\\{app_id}");
        let trimmed = read_hkcu_string(&subkey, Some("CustomActivator"))?;
        // SAFETY: `HSTRING` is NUL-terminated UTF-16.
        unsafe { CLSIDFromString(&HSTRING::from(trimmed)) }.ok()
    }

    /// Extracts `--app-id <id>` from the process arguments when launched by `nsh dev`.
    fn arg_app_id(args: &[String]) -> Option<&str> {
        args.windows(2)
            .find(|pair| pair[0] == "--app-id" && !pair[1].is_empty())
            .map(|pair| pair[1].as_str())
    }

    fn is_orphan_dev_toast_launch(args: &[String]) -> bool {
        cfg!(debug_assertions)
            && args.iter().any(|arg| arg == TOAST_ACTIVATED_ARG)
            && !args.iter().any(|arg| arg == "--dev-server")
    }

    /// Ensures `HKCU\Software\Classes\CLSID\{clsid}\LocalServer32` is registered
    /// before `nsh-platform-windows` calls `CoRegisterClassObject`.
    ///
    /// `nsh 0.7.0` skips writing `LocalServer32` in its dev host (`cfg!(feature = "dev")`),
    /// and in release builds writes it lazily on first notification call. Windows's
    /// `WpnUserService` requires `LocalServer32` under the `CustomActivator` CLSID
    /// to invoke `INotificationActivationCallback::Activate` even while the app runs.
    fn ensure_local_server_registration(app_id: &str, exe: &Path) -> Result<bool> {
        let clsid = expected_toast_activator_clsid(app_id);
        let subkey = format!(
            "Software\\Classes\\CLSID\\{}\\LocalServer32",
            format_clsid_braced(&clsid)
        );
        let command = format!("\"{}\" {TOAST_ACTIVATED_ARG}", exe.display());
        if read_hkcu_string(&subkey, None).as_deref() == Some(command.as_str()) {
            return Ok(false);
        }
        write_hkcu_string(&subkey, None, &command)?;
        Ok(true)
    }

    fn known_folder_path(folder_id: &GUID) -> Option<PathBuf> {
        // SAFETY: `SHGetKnownFolderPath` allocates a COM task string freed below.
        let raw: PWSTR = unsafe { SHGetKnownFolderPath(folder_id, KF_FLAG_DEFAULT, None) }.ok()?;
        let path = unsafe { raw.to_string() }.ok().map(PathBuf::from);
        // SAFETY: `raw` was allocated by `SHGetKnownFolderPath`.
        unsafe { CoTaskMemFree(Some(raw.0.cast::<c_void>())) };
        path
    }

    fn normalize_windows_path(path: &Path) -> String {
        let raw = path.to_string_lossy();
        let stripped = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else {
            raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned()
        };
        stripped.replace('/', "\\").to_ascii_lowercase()
    }

    fn same_executable_path(left: &Path, right: &Path) -> bool {
        if normalize_windows_path(left) == normalize_windows_path(right) {
            return true;
        }
        match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
            (Ok(a), Ok(b)) => normalize_windows_path(&a) == normalize_windows_path(&b),
            _ => false,
        }
    }

    fn read_property_string(
        store: &IPropertyStore,
        key: &windows::Win32::Foundation::PROPERTYKEY,
    ) -> Option<String> {
        // SAFETY: `key` is a valid static `PROPERTYKEY`.
        let value = unsafe { store.GetValue(key) }.ok()?;
        // SAFETY: `PropVariantToStringAlloc` returns a CoTaskMem-allocated UTF-16 string.
        let raw = unsafe { PropVariantToStringAlloc(&value) }.ok()?;
        let text = unsafe { raw.to_string() }.ok();
        // SAFETY: `raw` was allocated by `PropVariantToStringAlloc`.
        unsafe { CoTaskMemFree(Some(raw.0.cast::<c_void>())) };
        text
    }

    /// Patches `shortcut_path` so Windows Action Center invokes the app's
    /// `INotificationActivationCallback` COM server when a toast is clicked.
    /// Returns `Ok(true)` if the shortcut was updated, `Ok(false)` if skipped
    /// or already up to date.
    pub(super) fn ensure_shortcut_toast_activator(
        shortcut_path: &Path,
        expected_exe: &Path,
        app_id: &str,
        activator_clsid: GUID,
    ) -> Result<bool> {
        if !shortcut_path.is_file() {
            return Ok(false);
        }
        // SAFETY: COM is initialized on this thread before calling this helper.
        let link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }?;
        let persist: IPersistFile = link.cast()?;
        let shortcut_wide = HSTRING::from(shortcut_path.as_os_str());
        // SAFETY: `shortcut_wide` is a valid NUL-terminated path.
        unsafe { persist.Load(&shortcut_wide, STGM_READWRITE) }?;

        let mut target_buf = vec![0_u16; 32_768];
        // SAFETY: `target_buf` is a writable UTF-16 buffer for `IShellLinkW::GetPath`.
        unsafe { link.GetPath(&mut target_buf, ptr::null_mut(), 0) }?;
        let target_len = target_buf
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(target_buf.len());
        let target_path = PathBuf::from(String::from_utf16_lossy(&target_buf[..target_len]));
        if !same_executable_path(&target_path, expected_exe) {
            return Ok(false);
        }

        let store: IPropertyStore = link.cast()?;
        let Some(existing_aumid) = read_property_string(&store, &PKEY_AppUserModel_ID) else {
            return Ok(false);
        };
        if existing_aumid != app_id {
            return Ok(false);
        }

        // SAFETY: Reads the shortcut's existing `ToastActivatorCLSID` if set.
        if let Ok(existing_prop) = unsafe { store.GetValue(&PKEY_AppUserModel_ToastActivatorCLSID) }
            && let Ok(existing_clsid) = unsafe { PropVariantToGUID(&existing_prop) }
            && existing_clsid == activator_clsid
        {
            return Ok(false);
        }

        // SAFETY: Writes `VT_CLSID` to `PKEY_AppUserModel_ToastActivatorCLSID` and saves in place.
        let prop = unsafe { InitPropVariantFromCLSID(&activator_clsid) }?;
        unsafe {
            store.SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &prop)?;
            store.Commit()?;
            persist.Save(PCWSTR::null(), true)?;
            // Notify Explorer/Action Center so cached shortcut metadata picks up the CLSID immediately.
            SHChangeNotify(
                SHCNE_UPDATEITEM,
                SHCNF_PATHW,
                Some(shortcut_wide.as_ptr().cast::<c_void>()),
                None,
            );
        }
        Ok(true)
    }

    /// Registers the COM `LocalServer32` activator synchronously before `nsh`
    /// starts, and repairs existing Start Menu / Desktop shortcuts created by
    /// older installers that set `AppUserModelID` without `ToastActivatorCLSID`.
    pub(super) fn init() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            // Clicking a stale `Pilo Dev` toast after `nsh dev` stopped spawns the
            // dev host without `--dev-server`; exit quietly instead of opening an
            // unconnected window.
            if is_orphan_dev_toast_launch(&args) {
                std::process::exit(0);
            }
            let Ok(current_exe) = std::env::current_exe() else {
                return;
            };
            // In debug builds, only register `LocalServer32` for the real `nsh dev`
            // host (which passes `--dev-server`), never for `nsh test` or `describe`.
            let should_register_local_server =
                !cfg!(debug_assertions) || args.iter().any(|arg| arg == "--dev-server");
            if should_register_local_server {
                let app_id = arg_app_id(&args).unwrap_or(if cfg!(debug_assertions) {
                    DEV_APP_USER_MODEL_ID
                } else {
                    APP_USER_MODEL_ID
                });
                match ensure_local_server_registration(app_id, &current_exe) {
                    Ok(true) => log::info!(
                        target: "notification",
                        "registered Windows toast LocalServer32 for '{app_id}'"
                    ),
                    Ok(false) => {}
                    Err(error) => log::warn!(
                        target: "notification",
                        "failed to register Windows toast LocalServer32 for '{app_id}': {error}"
                    ),
                }
            }
            let _ = std::thread::Builder::new()
                .name("pilo-shortcut-sync".to_owned())
                .spawn(move || {
                    let Ok(_com) = ComApartment::init() else {
                        return;
                    };
                    let activator = expected_toast_activator_clsid(APP_USER_MODEL_ID);
                    for folder in [
                        &FOLDERID_Programs,
                        &FOLDERID_CommonPrograms,
                        &FOLDERID_Desktop,
                        &FOLDERID_PublicDesktop,
                    ] {
                        let Some(dir) = known_folder_path(folder) else {
                            continue;
                        };
                        let shortcut = dir.join(SHORTCUT_FILE_NAME);
                        match ensure_shortcut_toast_activator(
                            &shortcut,
                            &current_exe,
                            APP_USER_MODEL_ID,
                            activator,
                        ) {
                            Ok(true) => log::info!(
                                target: "notification",
                                "updated Windows shortcut ToastActivatorCLSID: {}",
                                shortcut.display()
                            ),
                            Ok(false) => {}
                            Err(error) => log::warn!(
                                target: "notification",
                                "failed to update Windows shortcut '{}': {error}",
                                shortcut.display()
                            ),
                        }
                    }
                });
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

        fn create_test_shortcut(path: &Path, target: &Path, aumid: Option<&str>) {
            let link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
            unsafe { link.SetPath(&HSTRING::from(target.as_os_str())) }.unwrap();
            if let Some(aumid) = aumid {
                let store: IPropertyStore = link.cast().unwrap();
                let prop = PROPVARIANT::from(aumid);
                unsafe {
                    store.SetValue(&PKEY_AppUserModel_ID, &prop).unwrap();
                    store.Commit().unwrap();
                }
            }
            let persist: IPersistFile = link.cast().unwrap();
            unsafe { persist.Save(&HSTRING::from(path.as_os_str()), true) }.unwrap();
        }

        fn read_toast_activator(path: &Path) -> Option<GUID> {
            let link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
            let persist: IPersistFile = link.cast().unwrap();
            unsafe { persist.Load(&HSTRING::from(path.as_os_str()), STGM_READWRITE) }.unwrap();
            let store: IPropertyStore = link.cast().unwrap();
            let prop = unsafe { store.GetValue(&PKEY_AppUserModel_ToastActivatorCLSID) }.ok()?;
            if prop.is_empty() {
                return None;
            }
            unsafe { PropVariantToGUID(&prop) }.ok()
        }

        #[test]
        fn nsh_clsid_matches_registered_pilo_activator() {
            assert_eq!(
                nsh_toast_activator_clsid(APP_USER_MODEL_ID),
                GUID::from_u128(0x58BCF293_2F89_430F_B5FA_7E0B41AFF62C)
            );
            assert_eq!(
                format_clsid_braced(&nsh_toast_activator_clsid(DEV_APP_USER_MODEL_ID)),
                "{6E3D1183-3C79-4E25-840B-2FB61AD0309D}"
            );
        }

        #[test]
        fn parses_dev_app_id_and_orphan_toast_launch() {
            let dev_args = vec![
                "--dev-server".to_owned(),
                "ws://127.0.0.1:8790/ws".to_owned(),
                "--app-id".to_owned(),
                "app.hsingjui.pilo.dev".to_owned(),
            ];
            assert_eq!(arg_app_id(&dev_args), Some("app.hsingjui.pilo.dev"));
            assert!(!is_orphan_dev_toast_launch(&dev_args));

            let orphan = vec![TOAST_ACTIVATED_ARG.to_owned(), "-Embedding".to_owned()];
            assert_eq!(arg_app_id(&orphan), None);
            assert_eq!(is_orphan_dev_toast_launch(&orphan), cfg!(debug_assertions));
        }

        #[test]
        fn patches_matching_shortcut_and_ignores_others() {
            let _com = ComApartment::init().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let exe = dir.path().join("Pilo.exe");
            let other_exe = dir.path().join("Other.exe");
            std::fs::write(&exe, b"").unwrap();
            std::fs::write(&other_exe, b"").unwrap();

            let expected = nsh_toast_activator_clsid(APP_USER_MODEL_ID);

            let matching = dir.path().join("Pilo.lnk");
            create_test_shortcut(&matching, &exe, Some(APP_USER_MODEL_ID));
            assert_eq!(read_toast_activator(&matching), None);
            assert!(
                ensure_shortcut_toast_activator(&matching, &exe, APP_USER_MODEL_ID, expected)
                    .unwrap()
            );
            assert_eq!(read_toast_activator(&matching), Some(expected));
            // Idempotent when already set.
            assert!(
                !ensure_shortcut_toast_activator(&matching, &exe, APP_USER_MODEL_ID, expected)
                    .unwrap()
            );

            // Different executable target must not be touched.
            let wrong_target = dir.path().join("WrongTarget.lnk");
            create_test_shortcut(&wrong_target, &other_exe, Some(APP_USER_MODEL_ID));
            assert!(
                !ensure_shortcut_toast_activator(&wrong_target, &exe, APP_USER_MODEL_ID, expected)
                    .unwrap()
            );
            assert_eq!(read_toast_activator(&wrong_target), None);

            // Different AUMID must not be touched.
            let wrong_aumid = dir.path().join("WrongAumid.lnk");
            create_test_shortcut(&wrong_aumid, &exe, Some("com.example.other"));
            assert!(
                !ensure_shortcut_toast_activator(&wrong_aumid, &exe, APP_USER_MODEL_ID, expected)
                    .unwrap()
            );
            assert_eq!(read_toast_activator(&wrong_aumid), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_packaged_macos_app_bundle_only_with_info_plist() {
        let dir = tempfile::tempdir().unwrap();
        let macos = dir.path().join("Pilo.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let exe = macos.join("Pilo");
        std::fs::write(&exe, b"").unwrap();
        assert!(!has_macos_app_bundle(&exe));

        std::fs::write(dir.path().join("Pilo.app/Contents/Info.plist"), b"<plist/>").unwrap();
        assert!(has_macos_app_bundle(&exe));

        let dev_exe = dir
            .path()
            .join("target/debug/nsh-app-pilo-desktop-macos-host");
        assert!(!has_macos_app_bundle(&dev_exe));
        assert!(!has_macos_app_bundle(Path::new("/usr/local/bin/pilo")));
    }

    #[test]
    fn press_queue_delivers_queued_live_and_hot_reload_waiters() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let queue = PressQueue::new();
            queue.push("first".to_owned());
            queue.push("second".to_owned());
            assert_eq!(queue.next().await.as_deref(), Some("first"));
            assert_eq!(queue.next().await.as_deref(), Some("second"));

            let first_wait = queue.next();
            let second_wait = queue.next();
            tokio::pin!(first_wait);
            tokio::pin!(second_wait);

            // Register first waiter, then supersede it with second waiter.
            assert!(futures_poll_once(&mut first_wait).is_none());
            assert!(futures_poll_once(&mut second_wait).is_none());
            assert_eq!(first_wait.await, None);

            queue.push("clicked".to_owned());
            assert_eq!(second_wait.await.as_deref(), Some("clicked"));

            let stopped_wait = queue.next();
            tokio::pin!(stopped_wait);
            assert!(futures_poll_once(&mut stopped_wait).is_none());
            queue.stop();
            assert_eq!(stopped_wait.await, None);
        });
    }

    #[test]
    fn press_queue_caps_backlog_to_newest_entries() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let queue = PressQueue::new();
            for index in 0..(MAX_QUEUED_PRESSES + 5) {
                queue.push(format!("id-{index}"));
            }
            assert_eq!(queue.next().await.as_deref(), Some("id-5"));
        });
    }

    fn futures_poll_once<F: std::future::Future + Unpin>(fut: &mut F) -> Option<F::Output> {
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        match std::pin::Pin::new(fut).poll(&mut cx) {
            std::task::Poll::Ready(value) => Some(value),
            std::task::Poll::Pending => None,
        }
    }
}
