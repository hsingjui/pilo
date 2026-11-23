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
