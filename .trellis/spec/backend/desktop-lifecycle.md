# Desktop Startup and Tray Lifecycle

## 1. Scope / Trigger

These are nsh desktop-only controls, not Remote WebUI endpoints. `desktop/nsh.json`
configures single-instance behavior and window bounds; `desktop/app/desktop-shell.ts`
owns tray, focus, shortcut registration, and quit handling.

## 2. Signatures

- `Application.launchAtLogin()` / `setLaunchAtLogin(enabled)` are used by
  `desktop/settings/desktop-pane.tsx`. nsh exposes a boolean, not a hidden-at-login mode.
- `Pilo.loadDesktopSettings()` returns `{ showShortcut, exitOnClose }`;
  `saveShowShortcut(shortcut)` and `saveExitOnClose(enabled)` persist desktop settings.
  `crates/pilo-runtime/src/storage/desktop.rs` owns the SQLite defaults and migrations.

## 3. Contracts

- The OS login setting is authoritative. Read it back after a successful write;
  don't mirror it into SQLite or infer hidden startup from it.
- The tray exposes Show, Hide, and Quit. Show and `secondInstance` focus the main
  window. An ordinary close hides it only when `exitOnClose` is false and the
  tray has been used or the global show shortcut registered successfully. A
  system close or an explicit quit awaits Host shutdown before `Application.quit()`.
- Register a replacement global shortcut before saving it. If saving fails,
  unregister the replacement and keep the previous key. Show the key hint in
  the tray only when registered. Keep global registration separate from the
  AppShell's focused-window keymap.

## 4. Validation & Error Matrix

- Login-setting read/write failures surface in Settings; a failed write does not
  optimistically change the switch.
- An unavailable global shortcut does not stop app startup. Failed replacement
  registration or persistence preserves the previous key.
- Until a way to reopen the window is known, close shuts down rather than hiding
  an unreachable Host. Repeated quit requests do not start another shutdown.

## 5. Good / Base / Bad Cases

- Good: tray Hide leaves active sessions and Remote WebUI running.
- Base: closing a browser tab has no effect on the Host or native window.
- Bad: a failed global registration shows the shortcut as available, or native
  Quit bypasses Host teardown.

## 6. Required Native Verification

Verify login opt-in/out, second launch, tray Show/Hide/Quit, default close versus
explicit exit, and global activation from another app. Check occupied-key
fallback and that shutdown releases sessions and the WebUI listener. Packaged
login and Dock behavior cannot be inferred from headless tests.

## 7. Wrong vs Correct

Wrong: expose OS startup on the Remote HTTP API or exit directly from a tray
handler. Correct: use nsh desktop APIs and the shared graceful-quit path.

For historical Tauri behavior, see
`git show 612a477:.trellis/spec/backend/desktop-lifecycle.md`.
