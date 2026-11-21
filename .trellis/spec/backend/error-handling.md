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
  and map at the boundary. `pilo-runtime` depends on `thiserror` but the raw-string
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
`shared/app-error.ts` (`toAppError`). It matches on substrings, so **keep error
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

## Pi RPC Compatibility Projection

### 1. Scope / Trigger

Pi tool and extension events pass through `PiEventAdapter` before reaching both
Desktop and WebUI. Keep this projection shared across Local/WSL/SSH.

### 2. Signatures

- `PiEventAdapter::adapt(generation: u64, message: &Value) -> Vec<RuntimeEvent>`
- `adapt_extension_error(generation: u64, message: &Value) -> Vec<RuntimeEvent>`

### 3. Contracts

- Preserve `tool_execution_start/update/end`, including nested calls carrying
  `parentToolCallId`, so users can inspect actual tool execution live. Nested
  calls are not standalone transcript entries and are not replayed on reload.
- The shared activity UI renders `codemode` arguments and results using the
  normal tool detail path, including text and images. History projection keeps
  `nestedCalls` and `details.calls` in the parent result payload as metadata;
  it does not project them as standalone child activities. Unknown metadata
  must not prevent loading the transcript.
- Map `extension_error { extensionPath?, event?, error: string }` to the existing
  `extension_ui_request { method: "notify", notifyType: "error", message, id }`.
  Generate a unique notification ID; include the extension basename (both path
  separators supported), hook name when present, and raw error text.
- Tool display names are presentation-only: `mcp__server__tool` becomes
  `server/tool`; the original tool name and call ID remain unchanged.

### 4. Validation & Error Matrix

- Present/missing/null `parentToolCallId`: preserve existing tool handling.
- `codemode` with a result but no arguments: allow the result disclosure.
- Missing/non-string `error`: ignore the malformed extension error.
- Missing extension path/hook: still show the error without requiring metadata.
- Extension error: notify only; never emit `RuntimeError` or stop the turn.

### 5. Good / Base / Bad Cases

- Good: codemode shows arguments and results in both live and history views.
- Base: older Pi tool events without parent metadata work unchanged.
- Bad: an extension failure must not mark the Pi process/session as failed.

### 6. Tests Required

When adding regression coverage, assert all three nested event kinds survive,
codemode arguments and results remain visible, history loads with nested-call
metadata without requiring child projection, notification IDs differ across
errors, Windows/POSIX basenames render, and extension errors do not end the turn.

### 7. Wrong vs Correct

- Wrong: hide actual nested execution to force live/replay parity, reject
  unknown tool-result metadata, or treat extension failures as fatal.
- Correct: keep live tool events, use normal codemode detail rendering and
  tolerant history projection, and reuse nonfatal extension notifications.
