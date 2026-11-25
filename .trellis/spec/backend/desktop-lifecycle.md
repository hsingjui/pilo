# Desktop Startup and Tray Lifecycle

## 1. Scope / Trigger

These are nsh desktop-only controls, not Remote WebUI endpoints. `nsh.json`
configures single-instance behavior and window bounds; `app/shell/desktop-shell.ts`
owns tray, focus, shortcut registration, and quit handling.

## 2. Signatures

- `Application.launchAtLogin()` / `setLaunchAtLogin(enabled)` are used by
  `app/settings/desktop-startup-section.tsx`. nsh exposes a boolean, not a hidden-at-login mode.
- `Pilo.loadDesktopSettings()` returns `{ showShortcut, exitOnClose }`;
  `saveShowShortcut(shortcut)` and `saveExitOnClose(enabled)` persist desktop settings.
  `crates/pilo-runtime/src/storage/desktop.rs` owns the SQLite defaults and migrations.
- `DesktopDock.setVisible(visible)` in `crates/pilo-desktop/src/dock.rs` switches
  macOS `NSApplicationActivationPolicy` between `Regular` (`true`) and
  `Accessory` (`false`) on the main queue, and is a no-op returning `false` on
  non-macOS platforms or when `NSApp` is not running. `DesktopDock.activate()`
  requests that Launch Services bring the current, inactive macOS app bundle
  forward. Unbundled development hosts and other platforms keep native window
  focus alone.

## 3. Contracts

- The OS login setting is authoritative. Read it back after a successful write;
  don't mirror it into SQLite or infer hidden startup from it.
- The tray exposes Show, Hide, and Quit. Show and `secondInstance` focus the main
  window. When `exitOnClose` is false, an ordinary close keeps the Host running:
  it hides the window if the tray has been used or the global show shortcut
  registered successfully, and otherwise minimizes it. A system close or an
  explicit quit awaits Host shutdown before `Application.quit()`.
- On macOS, hiding the main window to the tray switches activation policy to
  `Accessory` so the Dock icon is cleared while the menu-bar tray icon stays
  active. Showing the window restores `Regular` before calling `main.focus()`,
  and external window reopen/focus transitions also restore `Regular`; Dock
  bridge errors never block focusing the main window.
- Keep transparent tray marks in `assets/branding/tray*.svg`: macOS uses the
  monochrome template `app/assets/tray-template.svg` with transparent eyes;
  Windows/Linux use the 32px RGBA colored bitmap `app/assets/tray.png`
  (because nsh 0.6.1 tints SVG tray icons as monochrome templates on Windows too).
- Register a replacement global shortcut before saving it. If saving fails,
  unregister the replacement and keep the previous key. Show the key hint in
  the tray only when registered. Keep global registration separate from the
  AppShell's focused-window keymap. On macOS, after restoring the Dock and
  requesting window focus, a global shortcut press also requests foreground
  activation. Registration success alone does not prove foreground activation.

## 4. Validation & Error Matrix

- Login-setting read/write failures surface in Settings; a failed write does not
  optimistically change the switch.
- An unavailable global shortcut does not stop app startup. Failed replacement
  registration or persistence preserves the previous key.
- With `exitOnClose` off but no confirmed tray or shortcut, close minimizes so
  the window remains reachable through the OS. Repeated quit requests do not
  start another shutdown.

## 5. Good / Base / Bad Cases

- Good: tray Hide leaves active sessions and Remote WebUI running.
- Base: closing a browser tab has no effect on the Host or native window.
- Bad: a failed global registration shows the shortcut as available, or native
  Quit bypasses Host teardown.

## 6. Required Native Verification

Verify login opt-in/out, second launch, tray Show/Hide/Quit, default close versus
explicit exit, and global activation from another app using a physical keypress
with Pilo visible, minimized, and hidden to the tray. With the shortcut occupied
and the tray not yet used, check that an ordinary close with the switch off
minimizes and keeps sessions running. Check that shutdown releases sessions and
the WebUI listener. Packaged login and Dock behavior cannot be inferred from
headless tests.

## 7. Wrong vs Correct

Wrong: expose OS startup on the Remote HTTP API or exit directly from a tray
handler. Correct: use nsh desktop APIs and the shared graceful-quit path.

For historical Tauri behavior, see
`git show 612a477:.trellis/spec/backend/desktop-lifecycle.md`.
