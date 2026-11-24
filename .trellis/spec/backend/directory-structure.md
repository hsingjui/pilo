# Backend Directory Structure

> How the Rust backend is organized. The root Cargo workspace has four crates; the desktop shell is a fifth, standalone crate.

---

## Crate Layout

```
crates/pilo-domain/    # Serde data models and validation; no runtime dependency
crates/pilo-runtime/   # Host runtime: all business logic, storage, Pi RPC, Remote WebUI
crates/pilo-protocol/  # Shared wire types between the Host and pilo-server
crates/pilo-server/    # Long-running transport server for WSL/SSH remotes
crates/pilo-desktop/   # nsh shell crate (crates/pilo-desktop/Cargo.toml, own [workspace]); nsh builds it
```

Dependency direction: `pilo-desktop` → `pilo-runtime` → `pilo-domain`, `pilo-server` → `pilo-protocol`.
`pilo-runtime` stays shell-agnostic: the shell implements its ports (`HostPaths`, `HostShell`,
`WebAssets`) in `crates/pilo-desktop/src/pilo/shell.rs`.

## `crates/pilo-domain/src/`

Serde data types shared across the backend (`Connection`, `Project`, `SessionIndexEntry`, theme tokens, …). One file per concept, re-exported from `lib.rs`.

## `crates/pilo-runtime/src/`

| Path                          | Responsibility                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib.rs`                      | Module tree and the few crate-level entry points (`initialize_local_server_binary`, `initialize_server_resource_dir`, `handle_ssh_askpass`).          |
| `*_api.rs`, feature modules   | Operations the shells call (`project_api`, `session_api`, `runtime_api`, `connections`, `remote`, `preferences`, …).                                  |
| `storage.rs` + `storage/`     | SQLite index/cache (`connections`, `projects`, `sessions`, `session_ui_state`).                                                                        |
| `session_history/`            | Pi JSONL parsing and reading (`parser`, `reader`, `cache`, `types`, `tests`).                                                                          |
| `server_client/`              | Client side of the `pilo-server` stdio protocol (`manager`, `transport`).                                                                              |
| `remote/`                     | Remote WebUI host: HTTP/WS API, pairing, devices.                                                                                                      |
| `*.rs`                        | One module per capability: `pi_workspace`, `pi_events`, `terminal`, `git`, `ssh`, `wsl`, `remote_fs`, `credentials`, `events`. |

## `crates/pilo-desktop/src/` (nsh shell)

- `lib.rs` — `#[native_module("app/native")]` registration.
- `pilo/mod.rs` — the `Pilo` class TSX calls; nsh allows one `#[class] impl` block per class, so every exported method lives here and stays a thin call into `pilo-runtime`.
- `pilo/shell.rs` — the runtime ports as the nsh shell implements them; `pilo/host.rs` — runtime handle and shutdown; `pilo/encode.rs` — JSON conversion; `pilo/objects.rs` — `JsObject` argument/return types.

## `crates/pilo-protocol/src/`

- `lib.rs` — JSONL frame protocol, `Envelope`, capability constants, `read_frame`/`write_frame`.
- `proto/pilo.proto` — proto definition (built by `build.rs`).

## `crates/pilo-server/src/`

- `main.rs` — binary entry (`--version`, fingerprint, or serve stdio).
- `lib.rs` — stdio request loop and dispatch to handlers.
- `command.rs`, `environment.rs`, `fs_ops.rs` — leaf capabilities.
- `runtime_streams/` — long-lived streams (`pi`, `terminal`).
- `session/` — remote session index/parse/search/watch (`index`, `io`, `search`, `watch`, `activity`).

## Rules

- **Shell methods stay thin.** `crates/pilo-desktop/src/pilo` validates inputs and delegates to `pilo-runtime`; no multi-step logic in the shell.
- **One module per capability file.** Don't create a `utils.rs` dumping ground; put helpers next to the code that owns them.
- **Domain types are serde-only.** No DB or process logic in `pilo-domain`.
- **Rust 2024 edition.** Every crate declares `edition = "2024"`.
