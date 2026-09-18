use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
mod windows_identity {
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use std::time::Duration;

    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize, IPersistFile, STGM, STGM_READ, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        FOLDERID_CommonPrograms, FOLDERID_Programs, IShellLinkW, KF_FLAG_DEFAULT,
        SHGetKnownFolderPath, SLGP_RAWPATH, ShellLink,
    };
    use windows::core::{HSTRING, Interface, PCWSTR};

    /// 新建/认领快捷方式后，等 shell 把它的 AUMID 收进通知平台的时长。
    /// 等不到也照发不误，最坏是这一条不响，下次启动时快捷方式已经在了。
    const REGISTER_SETTLE: Duration = Duration::from_millis(1500);

    pub struct Identity {
        pub aumid: String,
        pub shortcut_name: String,
        pub product_name: String,
    }

    static IDENTITY: OnceLock<Identity> = OnceLock::new();
    static REGISTERED: OnceLock<bool> = OnceLock::new();

    pub fn initialize(app: &tauri::App) {
        let product_name = app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| "Pilo".to_owned());
        let identity = Identity {
            aumid: app.config().identifier.clone(),
            shortcut_name: format!("{product_name}.lnk"),
            product_name,
        };
        if IDENTITY.set(identity).is_err() {
            return;
        }

        // 注册在后台线程完成：COM 初始化和可能的 settle 等待都不该阻塞启动。
        // 失败时发送端会回退到 PowerShell 的 AUMID，通知仍能送达。
        let _ = std::thread::Builder::new()
            .name("pilo-notification-register".to_owned())
            .spawn(|| {
                let _ = ensure_registered();
            });
    }

    /// 发送通知前调用：已注册返回 Pilo 自己的 AUMID，否则调用方回退 PowerShell。
    pub fn registered_aumid() -> Option<&'static str> {
        let identity = IDENTITY.get()?;
        REGISTERED
            .get_or_init(|| ensure_registered())
            .then_some(identity.aumid.as_str())
    }

    fn ensure_registered() -> bool {
        let Some(identity) = IDENTITY.get() else {
            return false;
        };
        let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let registered = register_shortcut(identity);
        if com.is_ok() {
            unsafe { CoUninitialize() };
        }
        registered
    }

    /// 未打包的 Win32 应用要弹自己的 toast，开始菜单里必须有一条带本程序
    /// AUMID 的快捷方式：已有的直接复用，指向本 exe 却缺 AUMID 的补上
    /// （旧安装器建的就是这种），都没有才自建，避免开始菜单出现重复条目。
    fn register_shortcut(identity: &Identity) -> bool {
        let candidates = shortcut_candidates(identity);
        let aumid = identity.aumid.as_str();
        if candidates
            .iter()
            .any(|path| shortcut_aumid(path).as_deref() == Some(aumid))
        {
            return true;
        }

        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(error) => {
                eprintln!("[notification] failed to resolve current exe: {error}");
                return false;
            }
        };

        let adoptable = candidates.into_iter().find(|path| {
            path.is_file()
                && shortcut_aumid(path).as_deref() != Some(aumid)
                && shortcut_target(path).is_some_and(|target| paths_equal(&target, &exe))
        });
        if let Some(path) = adoptable {
            match set_shortcut_aumid(&path, aumid) {
                Ok(()) => {
                    std::thread::sleep(REGISTER_SETTLE);
                    return true;
                }
                Err(error) => {
                    eprintln!(
                        "[notification] failed to add AppUserModelID to start menu shortcut '{}': {error}",
                        path.display()
                    );
                }
            }
        }

        let Some(path) =
            known_folder(&FOLDERID_Programs).map(|dir| dir.join(&identity.shortcut_name))
        else {
            eprintln!(
                "[notification] start menu folder not found; notifications will fall back to the PowerShell identity"
            );
            return false;
        };
        match create_shortcut(&path, &exe, aumid) {
            Ok(()) => {
                std::thread::sleep(REGISTER_SETTLE);
                true
            }
            Err(error) => {
                eprintln!(
                    "[notification] failed to create start menu shortcut '{}': {error}",
                    path.display()
                );
                false
            }
        }
    }

    /// 开始菜单里可能放着本程序快捷方式的位置：安装版按安装权限落在
    /// 当前用户或所有用户的 Programs（根目录或产品子目录）下，覆盖两者。
    fn shortcut_candidates(identity: &Identity) -> Vec<PathBuf> {
        [FOLDERID_Programs, FOLDERID_CommonPrograms]
            .into_iter()
            .filter_map(|folder| known_folder(&folder))
            .flat_map(|root| {
                [
                    root.join(&identity.shortcut_name),
                    root.join(&identity.product_name)
                        .join(&identity.shortcut_name),
                ]
            })
            .collect()
    }

    fn known_folder(folder: &windows::core::GUID) -> Option<PathBuf> {
        unsafe {
            let raw = SHGetKnownFolderPath(folder, KF_FLAG_DEFAULT, None).ok()?;
            let path = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0 as *const _));
            Some(PathBuf::from(path?))
        }
    }

    fn load_shortcut(path: &Path, mode: STGM) -> windows::core::Result<IShellLinkW> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let file: IPersistFile = link.cast()?;
            let wide = HSTRING::from(path.as_os_str());
            file.Load(PCWSTR(wide.as_ptr()), mode)?;
            Ok(link)
        }
    }

    /// 快捷方式上记录的 AppUserModelID；没有该属性时是空串。
    fn shortcut_aumid(path: &Path) -> Option<String> {
        let link = load_shortcut(path, STGM_READ).ok()?;
        let store: IPropertyStore = link.cast().ok()?;
        let value = unsafe { store.GetValue(&PKEY_AppUserModel_ID) }.ok()?;
        Some(value.to_string())
    }

    fn shortcut_target(path: &Path) -> Option<PathBuf> {
        let link = load_shortcut(path, STGM_READ).ok()?;
        let mut buffer = [0u16; 1024];
        unsafe { link.GetPath(&mut buffer, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }.ok()?;
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        if len == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len])))
    }

    /// 给已有快捷方式补上本程序的 AUMID，其余属性原样保留。
    /// 只读句柄存不回同一个文件，要用 STGM_READWRITE 打开。
    fn set_shortcut_aumid(path: &Path, aumid: &str) -> windows::core::Result<()> {
        unsafe {
            let link = load_shortcut(path, STGM_READWRITE)?;
            let store: IPropertyStore = link.cast()?;
            store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(aumid))?;
            store.Commit()?;

            let file: IPersistFile = link.cast()?;
            let wide = HSTRING::from(path.as_os_str());
            file.Save(PCWSTR(wide.as_ptr()), true)
        }
    }

    /// 建一条指向当前 exe 的快捷方式，并把 AUMID 写进它的属性。
    /// 通知平台的"来源"名称与图标即取自这条快捷方式。
    fn create_shortcut(path: &Path, target: &Path, aumid: &str) -> windows::core::Result<()> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let target_wide = HSTRING::from(target.as_os_str());
            link.SetPath(PCWSTR(target_wide.as_ptr()))?;
            if let Some(dir) = target.parent() {
                let dir_wide = HSTRING::from(dir.as_os_str());
                link.SetWorkingDirectory(PCWSTR(dir_wide.as_ptr()))?;
            }

            let store: IPropertyStore = link.cast()?;
            store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(aumid))?;
            store.Commit()?;

            let file: IPersistFile = link.cast()?;
            let wide = HSTRING::from(path.as_os_str());
            file.Save(PCWSTR(wide.as_ptr()), true)
        }
    }

    fn paths_equal(a: &Path, b: &Path) -> bool {
        a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
    }
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub const NOTIFICATION_OPEN_SESSION_EVENT: &str = "pilo://notification-open-session";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationSessionTarget {
    pub project_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct MacOsDesktopNotificationRequest {
    pub title: String,
    pub body: String,
    pub target: Option<DesktopNotificationSessionTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct WindowsDesktopNotificationRequest {
    pub title: String,
    pub body: String,
    pub target: Option<DesktopNotificationSessionTarget>,
}

#[cfg(target_os = "macos")]
pub fn initialize_macos_notification_application(app: &tauri::App) {
    let bundle_identifier = if tauri::is_dev() {
        // A `tauri dev` process is not an installed .app bundle, so LaunchServices
        // cannot resolve Pilo's bundle identifier. The explicit notification icon
        // below still makes the notification visually belong to Pilo in dev mode.
        "com.apple.Terminal"
    } else {
        app.config().identifier.as_str()
    };

    if let Err(error) = mac_notification_sys::set_application(bundle_identifier) {
        eprintln!(
            "[notification] failed to register macOS notification application '{bundle_identifier}': {error}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn initialize_macos_notification_application(_app: &tauri::App) {}

#[cfg(target_os = "windows")]
pub fn initialize_windows_notification_application(app: &tauri::App) {
    windows_identity::initialize(app);
}

#[cfg(not(target_os = "windows"))]
pub fn initialize_windows_notification_application(_app: &tauri::App) {}

#[cfg(target_os = "macos")]
fn notification_icon_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in ["icon.icns", "icon.png"] {
            let candidate = resource_dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if tauri::is_dev() {
        let candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("icon.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn focus_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "windows")]
fn focus_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "windows")]
fn windows_notification_icon_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("icons").join("128x128.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if tauri::is_dev() {
        let candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("128x128.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[tauri::command]
pub fn send_macos_desktop_notification(
    app: tauri::AppHandle,
    request: MacOsDesktopNotificationRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use mac_notification_sys::{Notification, NotificationResponse};
        use tauri::Emitter;

        let icon_path = notification_icon_path(&app);
        std::thread::Builder::new()
            .name("pilo-notification".to_owned())
            .spawn(move || {
                let MacOsDesktopNotificationRequest {
                    title,
                    body,
                    target,
                } = request;
                let icon_path = icon_path.and_then(|path| path.to_str().map(str::to_owned));

                let mut notification = Notification::new();
                notification.title(&title).message(&body).default_sound();
                if let Some(icon_path) = icon_path.as_deref() {
                    notification.app_icon(icon_path);
                }

                if target.is_some() {
                    notification.wait_for_click(true);
                } else {
                    notification.asynchronous(true);
                }

                match notification.send() {
                    Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) => {
                        if let Some(target) = target {
                            focus_main_window(&app);
                            if let Err(error) = app.emit(NOTIFICATION_OPEN_SESSION_EVENT, target) {
                                eprintln!(
                                    "[notification] failed to emit notification target: {error}"
                                );
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("[notification] failed to show macOS notification: {error}");
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Err("native macOS notifications are unavailable on this platform".to_owned())
    }
}

#[tauri::command]
pub fn send_windows_desktop_notification(
    app: tauri::AppHandle,
    request: WindowsDesktopNotificationRequest,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Emitter;
        use tauri_winrt_notification::{IconCrop, Toast};
        use windows::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
        };

        let WindowsDesktopNotificationRequest {
            title,
            body,
            target,
        } = request;
        std::thread::Builder::new()
            .name("pilo-notification".to_owned())
            .spawn(move || {
                // WinRT toast 要求所在线程已初始化 COM。发送移出主线程后，
                // 注册等待（首次自建快捷方式后的 settle）也不会卡 UI。
                let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

                // 通知源身份：注册成功用 Pilo 自己的 AUMID（来源显示为 Pilo），
                // 注册失败退回 PowerShell 的 AUMID，保证通知仍能送达。
                let app_id = windows_identity::registered_aumid()
                    .map(str::to_owned)
                    .unwrap_or_else(|| Toast::POWERSHELL_APP_ID.to_owned());

                let click_app = app.clone();
                let mut toast =
                    Toast::new(&app_id)
                        .title(&title)
                        .text1(&body)
                        .on_activated(move |_| {
                            focus_main_window(&click_app);
                            if let Some(target) = target.clone()
                                && let Err(error) =
                                    click_app.emit(NOTIFICATION_OPEN_SESSION_EVENT, target)
                            {
                                eprintln!(
                                    "[notification] failed to emit notification target: {error}"
                                );
                            }
                            Ok(())
                        });

                if let Some(icon_path) = windows_notification_icon_path(&app) {
                    toast = toast.icon(&icon_path, IconCrop::Square, "Pilo");
                }

                if let Err(error) = toast.show() {
                    eprintln!("[notification] failed to show Windows notification: {error}");
                }

                if com.is_ok() {
                    unsafe { CoUninitialize() };
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, request);
        Err("native Windows notifications are unavailable on this platform".to_owned())
    }
}
