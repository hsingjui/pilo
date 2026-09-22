# Error Handling

> Backend errors cross the Tauri IPC boundary as **strings**.

---

## Convention: `Result<T, String>`

Every `#[tauri::command]` returns `Result<T, String>`:

```rust
#[tauri::command]
pub fn connection_naming_model_get(
    app: AppHandle,
    connection_id: String,
) -> Result<Option<ConnectionNamingModel>, String> {
    storage::get_connection_naming_model(&storage::open(&app)?, &connection_id)
}
```

- `storage::open(&app)?` already returns `Result<_, String>`, so `?` converts cleanly.
- Internal helpers may use native result types (`io::Result`, `rusqlite::Result`)
  and map at the boundary. `src-tauri` depends on `thiserror` but the raw-string
  boundary convention is what the code actually uses — do not introduce custom
  error enums just for a command.
- Prefix errors with context so the frontend can classify them. Use `format!` /
  `.map_err`:

```rust
.map_err(|error| format!("failed to open Pilo SQLite index: {error}"))?;
```

- Validate inputs first and return a clear message:

```rust
let connection_id = connection_id.trim();
if connection_id.is_empty() {
    return Err("connection id cannot be empty".to_owned());
}
```

## Cross-Boundary Contract

The frontend classifies raw error strings into a typed `AppError` in
`src/lib/app-error.ts` (`toAppError`). It matches on substrings, so **keep error
text stable and descriptive**. Signals the frontend recognizes:

`pi executable` / `not found in path`, `permission denied` + `ssh`,
`timed out`, `no such file`, `not running` / `closing` (session),
`connection refused` / `reset` / `server disconnected` (connection),
`model` / `provider`, `extension` / `mcp`, `pi runtime` / `pi rpc` / `process`.

If you add a new error class, update `toAppError` so users get actionable copy.

## `crates/pilo-server`

Remote server handlers also use `Result<_, String>` (`ServerReply`), and
`main.rs` returns `Result<(), Box<dyn std::error::Error>>` only at the top level.

## Rules

- Don't `.unwrap()` on fallible I/O, DB, or process work outside tests.
- Don't leak raw OS paths/credentials into user-facing messages; keep them in the
  string only if the frontend keeps them in `AppError.detail`.
- Prefer one descriptive message over chained error types.
