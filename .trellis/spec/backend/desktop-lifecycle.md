# Desktop Startup and Tray Lifecycle

> 状态：Tauri 壳已删除。本文中 Tauri 插件、`src-tauri` 文件与窗口 API 的描述只是历史行为基线；nsh 版实现以 `desktop/` 代码和 [nsh 桌面规范](../desktop/index.md) 为准，对齐后再回写本文。

## 1. Scope / Trigger

Desktop-only login startup, tray menus/icons, global window activation,
main/session window visibility and application exit. These are Host OS controls, not Remote WebUI endpoints. Closing
a browser tab does not hide or terminate the desktop Host.

## 2. Signatures

- `desktop_autostart_get() -> AutostartMode`
- `desktop_autostart_set({ mode: AutostartMode }) -> AutostartMode`
- `AutostartMode = "disabled" | "window" | "tray"` (Serde camelCase).
- `desktop_exit_on_close_get() -> boolean`
- `desktop_exit_on_close_set({ enabled: boolean }) -> boolean` returns the saved
  value; these are desktop-only commands in `desktop_tray.rs`.
- `desktop_tray_set_labels({ labels: { show, hide, quit } }) -> ()` updates the
  native menu from the main WebView's initialized i18n and language changes.
- `desktop_settings(id INTEGER PRIMARY KEY CHECK(id = 1), autostart_mode TEXT,
  show_shortcut TEXT)` stores the JSON-encoded startup mode and a normalized
  shortcut string. Missing mode means disabled; missing/NULL shortcut defaults
  to `mod+alt+p`. Add the nullable column with a guarded migration.
  `exit_on_close INTEGER NOT NULL DEFAULT 0` is added by a guarded migration;
  an absent row means false. Writes to any field must preserve the others.
- `desktop_window::show_main`, `hide_to_tray`, `sync_dock_visibility` own native
  visibility; `desktop_tray::handle_window_event` intercepts main close only.
- `desktop_shortcut::install(&AppHandle) -> Result<(), String>` registers the
  native show shortcut; `registered_label(&AppHandle) -> Option<String>` gates
  its tray hint.
- `desktop_shortcut_get() -> { shortcut: string, registered: boolean }`
- `desktop_shortcut_set({ shortcut: string }) -> { shortcut, registered: true }`
  returns only after registration and persistence succeed.

## 3. Contracts

- Register the single-instance plugin first. Manual second launches restore the
  existing main window; second launches carrying `--autostart` do not steal focus.
- Register login startup through the official autostart plugin, always passing
  `--autostart`. Only that argument plus saved `tray` mode plus successful tray
  creation permits a hidden startup. Normal manual launches always show the UI.
- OS registration is authoritative for whether startup is enabled. If disabled
  outside Pilo, reads return disabled without re-enabling it. An enabled OS entry
  with no enabled saved mode projects as `window`.
- Save under an immediate SQLite transaction; OS registration failure rolls back
  the preference. If commit fails after registration, attempt to restore the
  previous enabled state and log any compensation failure. Skip deleting an
  already-absent startup entry (older Windows plugin lines report NotFound).
- Autostart names are separate for debug/release (`Pilo Dev` / `Pilo`), matching
  their separate Tauri app-data identifiers. Keep plugin versions compatible with
  the locked Tauri runtime; do not upgrade the whole desktop stack for this feature.
- Main close hides by default, retaining the WebView, event subscriptions, Pi
  sessions, terminals and WebUI service. Settings → Preferences → Startup & system
  tray exposes an opt-in `exit_on_close` switch. When enabled, main close is
  prevented and calls `app.exit(0)` so all windows and services exit through the
  existing async teardown. Read the persisted preference on each main close;
  changes apply immediately across desktop windows and survive restart.
  Session-window close still destroys only that window. Neither this switch nor
  closing a browser tab changes WebUI browser behavior; no remote setting API
  is exposed. The tray's Hide action still hides all windows regardless of the
  preference; Show restores/unminimizes/focuses main.
  Reopening an existing hidden session must show and unminimize it before focus.
- macOS starts with `LSUIElement` in `src-tauri/Info.plist`, applies the chosen
  launch activation policy during setup, and uses Regular for visible windows /
  Accessory when none remain. Do not remove the Dock icon while another session
  window is visible. Windows hidden windows skip the taskbar; restore clears it.
- Keep transparent tray marks in `assets/branding/tray*.svg` and regenerate the
  corresponding PNG when editing an SVG. Both variants share the ghost silhouette
  and eye positions. The 44px RGBA template PNG is monochrome with transparent
  eyes for macOS system tinting; the 32px RGBA colored PNG uses blue with white
  eyes for Windows/Linux, remaining distinct on light and dark trays.
  `include_image!` embeds pixels at compile time, without requiring Tauri's
  runtime `image-png` feature. macOS left-click opens the menu; Windows
  left-click restores main and right-click opens the menu.
- Register the saved combination through the official global-shortcut plugin
  during native setup, before tray creation. The default `mod+alt+p` resolves to
  `CommandOrControl+Alt+P`. Only Pressed calls `show_main`; Released does nothing.
  All registrations owned by this plugin are show-only, not visibility toggles,
  and remain active while hidden. Keep them separate from frontend keydown
  shortcuts so they work without a focused WebView. No JavaScript plugin
  dependency, plugin IPC permission or Remote WebUI endpoint is needed.
- The desktop-only Settings → Shortcuts → Global recorder reuses shortcut key
  formatting and modifier validation. Record physical letter/digit/punctuation
  keys (`KeyboardEvent.code`), not Option-generated or non-Latin `key` values.
  Escape/blur cancels; modifier-only/unsafe combinations do not save; conflicts
  with current in-app shortcuts are rejected. The backend independently parses
  input and requires Ctrl/Command/Alt or F1–F12. `mod` means CommandOrControl,
  `meta` means Super; other tokens use the native parser.
- Save on a blocking worker, under an immediate SQLite transaction to serialize
  multiple windows. Register the new key before releasing the previous one.
  Registration failure preserves the old key and DB value; release failure
  removes the replacement. Persistence/commit failure attempts to restore the
  old registration and remove the new one; log compensation failures. An
  unchanged active key persists without re-registering. A saved but inactive
  key can be retried or replaced. Never silently overwrite it with the default.
- Show the current platform-specific hint in the localized tray label only
  when registered. The frontend setter refreshes tray labels after success;
  do not also register a menu accelerator for the same combination.
- Tray Quit calls `exit(0)` but must not bypass async resource cleanup. The exit
  guard has running/cleaning/ready stages; repeated quit requests wait during
  cleanup. Only the final exit after cleanup leaves the event loop. Preserve the
  updater's distinct restart exit code.

## 4. Validation & Error Matrix

- Missing/invalid saved mode: log startup read failure and show the main window.
- Tray creation failure: log, disallow hidden startup and let main close normally.
- Settings read failure: show retry UI; write failure: retain the prior selection
  and show a localized error. No optimistic OS-setting persistence. Load close
  behavior independently from OS autostart settings. If its native close-time
  read fails, log and retain default hide behavior (or normal close if no tray).
- Native show/hide/menu failures: log; never silently destroy a live session.
- Global shortcut initialization/registration failure (including another app
  owning the combination): log and continue startup with the normal tray and
  window behavior; omit the shortcut hint rather than claiming it is available.
  Settings show inactive status and offer retry/rebinding. Save failures retain
  the displayed previous value and show localized feedback.

## 5. Good / Base / Bad Cases

- Good: login silently starts the Host; WebUI works while no desktop window shows.
- Base: old installations remain opted out of login startup; manual launch shows.
- Bad: treating main Close as Quit without opt-in, hiding with no working tray,
  or reopening a duplicate process instead of restoring the hidden window.

## 6. Tests Required

Automated coverage: startup-hidden truth table (mode, launch source, tray
availability), absent/round-tripped SQLite mode, IPC mode payloads and rejection
propagation. Shortcut coverage includes safe/invalid parsing, native replacement
conflicts and persistence rollback, same-key saves, nullable-column migration
and preservation of startup settings, IPC failures and tray refresh, physical
key recording on macOS/Windows layouts, and desktop-only accessible rendering.
Close-behavior coverage (pending explicit authorization; no tests added/run):
absent-row/default-false and boolean round-trips, idempotent migration preserving
startup/shortcut values, writes preserving other columns, IPC save/load errors,
independent accessible settings loading/retry, default hide vs opt-in graceful
exit with another session window open, unchanged session-window close/tray Hide,
and restart persistence. When authorized, run frontend format/check/build and
unit tests, Rust fmt/check/clippy and library tests.

Native acceptance remains manual: Windows login in both modes, opt-out/restart,
tray Show/Hide/Quit, taskbar removal, repeated launches/quit during active work,
visible/hidden session windows and WebUI availability after main close. macOS
additionally needs packaged-launch Dock behavior, menu-bar dark/light contrast,
reopen and Cmd+Q. Verify the global shortcut from another app after main close,
Hide to Tray and minimization, including hidden autostart, occupied-key fallback
and freeing the shortcut on Quit. Compilation/unit tests do not verify those OS
interactions.

## 7. Wrong vs Correct

Wrong: use browser localStorage to decide native startup, expose autostart over
remote HTTP, or use `std::process::exit` directly from the tray handler.
Correct: native-owned persisted mode, desktop IPC only, official OS registration,
visibility changes instead of destruction by default, and explicit opt-in exit
through the existing bounded teardown.
