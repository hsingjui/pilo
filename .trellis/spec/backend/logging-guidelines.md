# Logging Guidelines

> There is **no logging framework** in this codebase. Do not add one without a
> project decision — match what exists.

---

## Current State

- No `tracing`, no `log`, no subscriber. `AGENTS.md` lists `tracing` under the
  intended stack, but the code does not use it.
- Diagnostics use `eprintln!` with a bracketed subsystem tag.

```rust
eprintln!("[window-state] failed to restore main window: {error}");
eprintln!("[server-prewarm] failed to load projects: {error}");
eprintln!("[notification] failed to show macOS notification: {error}");
eprintln!("[runtime-events] failed to send Tauri channel event: {error}");
```

## Conventions

- Format: `eprintln!("[<subsystem>] <what failed>: {error}")`.
- Tag matches the owning module/feature, not the file path:
  `[window-state]`, `[server-prewarm]`, `[notification]`, `[runtime-events]`.
- Log at boundaries where an error is swallowed (background task, event send,
  best-effort side effect). If an error propagates to the frontend, do **not**
  also log it — the `Result` is the report.
- No per-request/per-message logs on hot paths (streaming, virtualization,
  session parsing). They would flood stderr.
- `crates/pilo-server` stdout is a protocol channel: only `--version` /
  fingerprint subcommands `println!`. Never print to stdout in service mode;
  use stderr for diagnostics.
- `debug_trace` / `debug_runtime_trace_log` exist as opt-in frontend-driven
  tracing. Use those for runtime tracing instead of ad-hoc prints.

## What to log

- Startup/teardown failures that would otherwise be silent.
- Background task failures (session watcher, server prewarm, notification send).
- Environment probes (which Pi executable was found) when it aids support.

## What not to log

- Secrets, credentials, SSH passwords, keyring values.
- Full conversation/JSONL content.
- Anything in a tight loop.
