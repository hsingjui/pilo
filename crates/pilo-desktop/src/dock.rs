//! macOS Dock visibility control for tray hide/show transitions.
//!
//! `nsh` 0.6.1 does not expose AppKit's `NSApplicationActivationPolicy`, so
//! hiding the main window keeps the Dock icon and running indicator. This
//! module switches between `Regular` (shown in Dock) and `Accessory` (menu-bar
//! tray only) on the macOS main queue.
//!
//! A pinned Dock icon still launches a hidden (`Accessory`) Pilo: Launch
//! Services activates it, but no window shows. While hidden, an activation
//! restores the Dock icon and shows the main window like a Dock reopen.

use nsh_core::prelude::*;

/// Controls Pilo's macOS Dock visibility and foreground activation.
#[module]
pub struct DesktopDock;

#[module]
impl DesktopDock {
    /// Shows or hides the macOS Dock icon (`Regular` vs `Accessory`).
    ///
    /// Returns `true` when AppKit applied the requested policy, and `false` on
    /// non-macOS platforms or when `NSApplication` is not running.
    pub async fn set_visible(visible: bool) -> bool {
        #[cfg(target_os = "macos")]
        {
            macos::set_dock_visible(visible).await
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = visible;
            false
        }
    }

    /// Requests foreground activation of the current macOS app bundle.
    pub fn activate() {
        #[cfg(target_os = "macos")]
        macos::activate();
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use dispatch2::DispatchQueue;
    use objc2::{
        ClassType, class, define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, Bool, NSObject},
        sel,
    };
    use tokio::sync::oneshot;

    pub(super) const NS_APPLICATION_ACTIVATION_POLICY_REGULAR: isize = 0;
    pub(super) const NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY: isize = 1;
    /// `NSApplicationActivationOptions.activateAllWindows`.
    pub(super) const NS_APPLICATION_ACTIVATE_ALL_WINDOWS: std::ffi::c_ulong = 1 << 0;

    pub(super) const fn activation_policy_for_visibility(visible: bool) -> isize {
        if visible {
            NS_APPLICATION_ACTIVATION_POLICY_REGULAR
        } else {
            NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY
        }
    }

    /// Returns the already-initialized `NSApp` singleton without instantiating
    /// AppKit in headless test processes.
    unsafe fn running_ns_application() -> Option<*mut AnyObject> {
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"NSApp".as_ptr()) };
        if symbol.is_null() {
            return None;
        }
        let app = unsafe { *(symbol.cast::<*mut AnyObject>()) };
        (!app.is_null()).then_some(app)
    }

    pub(super) fn activate() {
        DispatchQueue::main().exec_async(|| {
            // SAFETY: Runs on the main queue. These AppKit selectors return
            // Objective-C objects or BOOL, as declared below.
            unsafe {
                let Some(app) = running_ns_application() else {
                    return;
                };
                let active: Bool = msg_send![app, isActive];
                let policy: isize = msg_send![app, activationPolicy];
                if active.as_bool() || policy != NS_APPLICATION_ACTIVATION_POLICY_REGULAR {
                    return;
                }

                // A Launch Services open asks for the running app, unlike window
                // focus: the bundle's default handler brings it back to the
                // foreground (its own reopen handler keeps it behind the front app).
                let running: *mut AnyObject =
                    msg_send![class!(NSRunningApplication), currentApplication];
                let url: *mut AnyObject = msg_send![running, bundleURL];
                if url.is_null() {
                    return;
                }
                let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
                let opened: Bool = msg_send![workspace, openURL: url];
                if !opened.as_bool() {
                    log::warn!("Failed to activate the Pilo application bundle");
                    return;
                }
                // The open activates the app once; activate again, now with the
                // Dock back and every window, so the main window is the key one.
                DispatchQueue::main().exec_async(|| {
                    let Some(app) = running_ns_application() else {
                        return;
                    };
                    let policy: isize = msg_send![app, activationPolicy];
                    if policy != NS_APPLICATION_ACTIVATION_POLICY_REGULAR {
                        return;
                    }
                    let running: *mut AnyObject =
                        msg_send![class!(NSRunningApplication), currentApplication];
                    // The option is an `NSUInteger`: a platform-sized word.
                    let activated: Bool =
                        msg_send![running, activateWithOptions: NS_APPLICATION_ACTIVATE_ALL_WINDOWS];
                    if !activated.as_bool() {
                        log::warn!("Failed to activate Pilo after its Dock icon returned");
                    }
                });
            }
        });
    }

    define_class!(
        // SAFETY: `NSObject` has no subclassing requirements and this class
        // does not implement `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "PiloDockActivationObserver"]
        struct ActivationObserver;

        impl ActivationObserver {
            #[unsafe(method(applicationDidBecomeActive:))]
            fn application_did_become_active(&self, _notification: *mut AnyObject) {
                show_after_hidden_activation();
            }
        }
    );

    /// Activated while the Dock icon is hidden (a pinned Dock icon, `open`,
    /// a notification): restore the Dock icon and show the main window through
    /// the app delegate's Dock reopen handler.
    fn show_after_hidden_activation() {
        // SAFETY: Notification callbacks run on the main thread. The selectors
        // return Objective-C objects or BOOL, as declared below.
        unsafe {
            let Some(app) = running_ns_application() else {
                return;
            };
            let policy: isize = msg_send![app, activationPolicy];
            if policy != NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY {
                return;
            }
            let delegate: *mut AnyObject = msg_send![app, delegate];
            if delegate.is_null() {
                return;
            }
            let reopens: Bool = msg_send![
                delegate,
                respondsToSelector: sel!(applicationShouldHandleReopen:hasVisibleWindows:)
            ];
            if !reopens.as_bool() {
                return;
            }
            if !apply_activation_policy_on_main(NS_APPLICATION_ACTIVATION_POLICY_REGULAR) {
                log::warn!("Failed to restore the Pilo Dock icon after activation");
                return;
            }
            let _: Bool = msg_send![
                delegate,
                applicationShouldHandleReopen: app,
                hasVisibleWindows: Bool::NO
            ];
        }
    }

    /// Observes app activation once, on the main thread, for the process's life.
    fn observe_activation_on_main(app: *mut AnyObject) {
        static OBSERVE: std::sync::Once = std::sync::Once::new();
        OBSERVE.call_once(|| {
            // SAFETY: Called on the main thread with the running `NSApp`.
            // `NSApplicationDidBecomeActiveNotification` is an `NSString *const`
            // exported by AppKit. The notification center does not retain its
            // observers, so the observer is intentionally leaked.
            unsafe {
                let symbol = libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"NSApplicationDidBecomeActiveNotification".as_ptr(),
                );
                if symbol.is_null() {
                    log::warn!("Failed to observe Pilo activation for the hidden Dock icon");
                    return;
                }
                let name = *(symbol.cast::<*mut AnyObject>());
                let observer: Retained<ActivationObserver> =
                    msg_send![ActivationObserver::class(), new];
                let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
                let _: () = msg_send![
                    center,
                    addObserver: &*observer,
                    selector: sel!(applicationDidBecomeActive:),
                    name: name,
                    object: app
                ];
                std::mem::forget(observer);
            }
        });
    }

    fn apply_activation_policy_on_main(policy: isize) -> bool {
        // SAFETY: Called only on the macOS main thread. `running_ns_application`
        // returns an already-initialized `NSApplication*`, and
        // `setActivationPolicy:` takes an `NSInteger` (`isize`) and returns `BOOL`.
        unsafe {
            let Some(app) = running_ns_application() else {
                return false;
            };
            let applied: Bool = msg_send![app, setActivationPolicy: policy];
            if applied.as_bool() && policy == NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY {
                observe_activation_on_main(app);
            }
            applied.as_bool()
        }
    }

    pub(super) async fn set_dock_visible(visible: bool) -> bool {
        // Bail out before touching the main queue when AppKit is not running
        // (e.g. headless tests whose main thread does not drain `dispatch_main`).
        if unsafe { running_ns_application() }.is_none() {
            return false;
        }
        let policy = activation_policy_for_visibility(visible);
        // SAFETY: `pthread_main_np` is a thread-safe Darwin syscall returning
        // non-zero on the main thread.
        if unsafe { libc::pthread_main_np() } != 0 {
            return apply_activation_policy_on_main(policy);
        }
        let (tx, rx) = oneshot::channel();
        DispatchQueue::main().exec_async(move || {
            let _ = tx.send(apply_activation_policy_on_main(policy));
        });
        rx.await.unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_visibility_to_ns_application_activation_policy() {
        assert_eq!(
            macos::activation_policy_for_visibility(true),
            macos::NS_APPLICATION_ACTIVATION_POLICY_REGULAR
        );
        assert_eq!(
            macos::activation_policy_for_visibility(false),
            macos::NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY
        );
    }

    #[test]
    fn set_visible_is_noop_without_running_appkit_application() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let applied = rt.block_on(DesktopDock::set_visible(false));
        assert!(!applied);
    }
}
