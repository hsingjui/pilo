# Logging Guidelines

Pilo uses `tauri-plugin-log` for desktop log persistence. Rust code logs through
`log` macros; the plugin writes the desktop log file and handles bounded
rotation.

## Configuration

`src-tauri/src/lib.rs` registers the log plugin before `setup` with:

- `Debug` level for debug builds and `Info` for release builds;
- the default Tauri log directory (`app_log_dir()`), with a 5 MB file limit;
- `RotationStrategy::KeepSome(4)`, giving up to four archived 5 MiB files plus the active file (about 25 MiB total);
- the `Webview` target so Rust log entries remain visible in DevTools through
  the frontend `attachLogger()` bridge.

The frontend registers one `attachLogger()` listener from `src/main.tsx` and
replays backend records through the original browser console methods. It bridges
only `console.error` and `console.warn` to the plugin's `error` and `warn` APIs.
`console.log` and other hot-path console output are not persisted. The Rust
`Webview` target filters records whose target starts with `WEBVIEW_TARGET`, so
frontend-originated records are persisted to the log file without being echoed
back into the webview.

The About settings page opens the same directory with `appLogDir()` and the
`opener` plugin. Do not duplicate the path calculation in Rust or TypeScript.

## Rust conventions

Use the `log` facade and keep the subsystem tag as the `target`:

```rust
log::error!(target: "window-state", "failed to restore main window: {error}");
log::warn!(target: "pilo-server", "[{label}] {message}");
```

- Tag matches the owning module/feature, not the file path:
  `window-state`, `server-prewarm`, `notification`, `runtime-events`, or
  `pilo-server`.
- Log at boundaries where an error is swallowed (background task, event send,
  or best-effort side effect). If an error propagates to the frontend, do not
  also log it.
- Do not add per-request/per-message logs on hot paths (streaming,
  virtualization, session parsing).
- `crates/pilo-server` stdout is a protocol channel: only `--version` /
  fingerprint subcommands may print there. Service diagnostics stay on stderr;
  `src-tauri/src/runtime/server_client.rs` routes that stderr into the desktop
  logger.

## What to log

- Startup and teardown failures that would otherwise be silent.
- Background task failures (session watcher, server prewarm, notification send).
- Environment probes when they aid support.
- Frontend errors and warnings that are already reported through `console`.

## What not to log

- Secrets, credentials, SSH passwords, keyring values, or access tokens.
- Full conversation/JSONL content.
- Anything in a tight loop.
- Raw objects when a concise error message is sufficient.

When adding a new diagnostic boundary, prefer one descriptive message and keep
user-facing command errors separate from diagnostic logs.
