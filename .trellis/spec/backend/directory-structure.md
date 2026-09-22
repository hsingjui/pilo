# Backend Directory Structure

> How the Rust backend is organized. This project has three crates.

---

## Crate Layout

```
src-tauri/          # Tauri desktop app (the main backend)
crates/pilo-protocol/  # Shared wire types between desktop and remote server
crates/pilo-server/    # Long-running transport server for WSL/SSH remotes
```

`Cargo.toml` at the repo root is a workspace with `default-members = ["src-tauri"]`,
so plain `cargo check` builds the desktop app.

## `src-tauri/src/` (desktop backend)

| Path | Responsibility |
|------|----------------|
| `main.rs` | Thin binary entry; delegates to `lib.rs`. |
| `lib.rs` | App wiring: `Builder`, plugin registration, `.manage()` state, `invoke_handler` registration. |
| `domain/` | Serde data types shared across the backend (`Connection`, `Project`, `SessionIndexEntry`, …). One file per concept, re-exported from `domain/mod.rs`. |
| `runtime/` | All business logic. |
| `runtime/commands/` | `#[tauri::command]` entry points only — thin wrappers, grouped by feature (`connections`, `projects`, `sessions`, `runtime`, `appearance`). |
| `runtime/storage.rs` + `runtime/storage/` | SQLite index/cache (`connections`, `projects`, `sessions`, `session_ui_state`). |
| `runtime/session_history/` | Pi JSONL parsing and reading (`parser`, `reader`, `cache`, `types`, `tests`). |
| `runtime/server_client/` | Client side of the `pilo-server` stdio protocol (`manager`, `transport`). |
| `runtime/*.rs` | One module per capability: `pi_workspace`, `pi_events`, `terminal`, `preview`, `git`, `ssh`, `wsl`, `parallel`, `remote_fs`, `credentials`, `events`, `debug_trace`, `desktop_notifications`. |

## `crates/pilo-protocol/src/`

- `lib.rs` — JSONL frame protocol, `Envelope`, capability constants, `read_frame`/`write_frame`.
- `proto/pilo.proto` — proto definition (built by `build.rs`).

## `crates/pilo-server/src/`

- `main.rs` — binary entry (`--version`, fingerprint, or serve stdio).
- `lib.rs` — stdio request loop and dispatch to handlers.
- `command.rs`, `environment.rs`, `fs_ops.rs` — leaf capabilities.
- `runtime_streams/` — long-lived streams (`pi`, `preview`, `terminal`).
- `session/` — remote session index/parse/search/watch (`index`, `io`, `search`, `watch`, `activity`).

## Rules

- **Commands stay thin.** Validate inputs and delegate to `runtime/*` or `storage/*`. No multi-step logic in `commands/`.
- **One module per capability file.** Don't create a `utils.rs` dumping ground; put helpers next to the code that owns them.
- **Domain types are serde-only.** No DB or process logic in `domain/`.
- **Rust 2024 edition.** `src-tauri` declares `edition = "2024"`.
