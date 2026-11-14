# Database Guidelines

> SQLite conventions. Pi session data is a **desktop index/cache**, never the
> conversation source of truth. Pilo-owned preferences may use SQLite as their
> authoritative store.

---

## Overview

- Engine: `rusqlite` (bundled SQLite), no ORM, no query builder.
- DB file: `pilo.sqlite3` in Tauri `app_data_dir()`.
- Opened through `storage::open(&app)` (`src-tauri/src/runtime/storage/schema.rs`).
- `pnpm tauri dev` (also used by `pnpm dev`) automatically merges
  `src-tauri/tauri.dev.conf.json` through `scripts/tauri.mjs`. Development uses
  `app.hsingjui.pilo.dev`; release retains `app.hsingjui.pilo`. Keep their app
  data, logs and WebView storage separate: a development schema migration can
  make the shared database incompatible with an older installed release.
  Direct `pnpm exec tauri dev` / `cargo tauri dev` bypass the wrapper and must
  explicitly pass `--config src-tauri/tauri.dev.conf.json`. Pi JSONL remains
  shared; never copy or delete the release database to initialize dev.
- The Pi JSONL files are the single source of truth; SQLite only indexes/caches
  (`sessions`, `project_model_cache`, `session_ui_state`, …). Never copy full
  conversation data into the DB.
- Pilo-owned project Scope lives separately in `project_model_scopes`, not in Pi
  settings or `project_model_cache`; see [Project Model Scope](./project-model-scope.md).

## Connection Setup

`storage::open` is the only entry point. It sets:

```rust
connection.busy_timeout(Duration::from_secs(2))?;
connection.execute_batch("PRAGMA foreign_keys = ON;")?;
```

Schema init is memoized per DB path via `INITIALIZED_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>>`.

## Schema & Migrations

There is no migration framework. The pattern is **idempotent DDL plus guarded column adds**:

1. `initialize_schema` runs `CREATE TABLE IF NOT EXISTS ...` and
   `CREATE INDEX IF NOT EXISTS ...` for every table.
2. New columns are added with a helper that checks `pragma_table_info`
   before `ALTER TABLE`:

```rust
fn ensure_connection_columns(db: &SqliteConnection) -> Result<(), String> {
    let has_pi_executable = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('connections') WHERE name='pi_executable')",
        [], |row| row.get::<_, i64>(0),
    ).map(|exists| exists != 0).map_err(|error| error.to_string())?;
    if !has_pi_executable {
        db.execute_batch("ALTER TABLE connections ADD COLUMN pi_executable TEXT; ...")?;
    }
    Ok(())
}
```

3. Cross-cutting renames are handled by an explicit legacy migration
   (`migrate_legacy_workspaces_schema`) so old DBs upgrade in place.

## Naming Conventions

- Tables and columns: `snake_case`.
- JSON blobs: `<name>_json` (e.g. `kind_json`, `metadata_json`).
- Millisecond timestamps: `<name>_ms` (`updated_at_ms`, `last_opened_at_ms`).
- ISO-8601 text timestamps (Pi-sourced): `created_at`, `updated_at`.
- Row IDs are text, not autoincrement: `project:<connection>:<path>` style.

## Query Patterns

- Named/positional `params![]` macros, never string interpolation in SQL.
- Store modules expose small typed functions (`list_projects`, `upsert_project`,
  `get_connection`, `ensure_local_connection`) — callers never write SQL.
- `INSERT ... ON CONFLICT ... DO UPDATE` for upserts.
- `upsert_project` deliberately does **not** overwrite the connection
  configuration — a project row references the live connection. Keep that invariant.

## Project-Scoped Session Identity

### Scope / Trigger

Local, WSL and SSH connections can contain identical session paths and Pi IDs.
Project identity must survive storage, IPC, sidebar actions and unread tracking.

### Signatures

- `sessions` and `session_ui_state`: `PRIMARY KEY(project_id, session_path)`.
- `session_update_ui_state`: `{ sessionPath, update, projectId?: string }`
  returns `SessionIndexEntry`.
- Sidebar select/delete callbacks take `(sessionId, projectId)`; rename also
  carries `projectId`. Do not change the Pi session ID itself.

### Contracts

`ensure_session_project_keys` rebuilds legacy path-only tables in an immediate
transaction. It copies indexed rows and joins UI preferences to their indexed
owner before replacing tables and indexes. Legacy UI rows without an indexed
owner cannot be assigned safely and are not migrated. Pi JSONL is unchanged.
All joins, upserts and deletions use project plus path. UI lookup, selection,
React keys and unread state use project plus Pi ID.

`get_session` resolves an omitted project only for legacy callers, rejecting
multiple owners before reading the row. Scoped reads use direct equality on
both `project_id` and `session_path`; do not hide the project predicate behind
`? IS NULL OR ...`, which prevents direct use of the composite primary key.

### Validation & Errors

- Explicit project and indexed path: update only that project's row.
- Omitted project, unique indexed path: accept for old IPC callers.
- Omitted project, multiple owners: reject with
  `session path is ambiguous; projectId is required`.
- Missing indexed row: reject as not indexed; never create unowned preferences.
- Failed migration: transaction rolls back; schema initialization fails.

### Good / Base / Bad Cases

- Good: two projects share a path; renaming or deleting one leaves the other intact.
- Base: a legacy database upgrades and preserves preferences of indexed sessions.
- Bad: selecting the first row matching only `sessionPath` or `piSessionId`.

### Required Regression Checks

When verification is authorized, cover legacy migration and repeated init,
colliding paths across projects, scoped delete/rename, ambiguous legacy IPC,
and desktop/WebUI selection and unread isolation. Migration cannot reconstruct
rows or preferences already overwritten by the old global path key.

Installed and development builds share `app_data_dir()` when their Tauri
identifier is the same. After the scoped-key migration, an older binary still
using `ON CONFLICT(session_path)` fails with `ON CONFLICT clause does not match
any PRIMARY KEY or UNIQUE constraint`. Check running executable paths and the
actual table/index definitions before changing migrations. Do not restore global
path uniqueness to accommodate an old process; stop using the incompatible build.

### Wrong vs Correct

Wrong: `DELETE FROM sessions WHERE session_path=?1`.
Correct: `DELETE FROM sessions WHERE project_id=?1 AND session_path=?2`.

## Windows Pi Session Workspace Paths

### 1. Scope / Trigger

Windows Local Pi startup and session scan/search/watch/activity, including
Local-Pi SSH anchors. Desktop and WebUI use the same Host workspace adapter.

### 2. Signatures

- `resolve_session_project_with_paths` and `resolve_pi_runtime_with_paths` return
  runtime-only project views through `normalize_local_pi_project(Project)`.
- Server `session_dir_key(project)` mirrors Pi's default session-directory key.
  No command, protocol or database schema changes.

### 3. Contracts

On Windows, normalize only projects whose resolved connection is Local:
`\\?\D:\work` becomes `D:\work`, and `\\?\UNC\host\share\work` becomes
`\\host\share\work`. Update the runtime view's path and metadata cwd together.
Keep the stored project path, stable project ID, original workspace identity and
JSONL unchanged. Do not apply the Host's Windows rules to WSL/SSH workspace paths.

Use the same runtime cwd for Pi startup and session indexing: header cwd checks
must see the value Pi writes. Merely sanitizing the scan directory can hide the
error while still dropping sessions or breaking Pi's own directory creation.
Pi encodes cwd by removing exactly one leading slash/backslash, then replacing
slashes, backslashes and colons with hyphens and surrounding the result with `--`.
In particular, ordinary UNC keys retain one encoded leading separator.

### 4. Validation & Error Matrix

- Verbatim drive cwd -> no `?` in Pi directory names; scan must not fail with
  Windows `os error 123`.
- Existing canonical stored project -> runtime normalization without re-add or
  migration; original project ID and stored path remain unchanged.
- UNC cwd -> `---host-share-work--`, not `--host-share-work--`.
- Missing ordinary session directory -> empty result, not a scan error.
- POSIX WSL/SSH workspace -> unchanged.

### 5. Good / Base / Bad Cases

Good: canonical Local projects scan Pi's actual directory and match header cwd.
Base: ordinary drive/POSIX paths retain their current identity. Bad: suppress
`os error 123` as an empty list, or strip every leading UNC separator.

### 6. Coverage

Windows Dev manual verification: previously failing Local reconciliation and
watcher restart succeed with the stored canonical path intact; two WSL projects
still reconcile. An isolated Windows embedded server finds Pi-generated drive
and UNC fixture sessions through full scan, targeted scan and search; fixtures
are removed without touching the user's agent directory. This checks UNC key
encoding, not live network-share access.

Regression tests in `runtime/pi_workspace.rs` exercise both workspace adapters
with ordinary/verbatim drive and UNC paths, check that only the runtime path/cwd
change, and preserve WSL/SSH paths. Windows normalization assertions run on Windows;
other hosts assert unchanged paths. These tests use a test-only `HostPaths` and
never access the database or filesystem. `pilo-server/src/session/mod.rs` tests
Pi-compatible drive/UNC/POSIX directory keys on every host. These tests pass in
the WSL workspace test run; Windows-only normalization assertions still require
a Windows run. Live network-share access and JSONL scan integration remain
outside their coverage.

### 7. Wrong vs Correct

Wrong: change `environment.inspect` output and regenerate existing project IDs,
or fix scan alone while passing verbatim cwd to Pi.
Correct: normalize the runtime-only Local project view once for both Pi and
session services, preserving the authoritative project and JSONL.

## Headerless Session Indexing and Safe Deletion

### 1. Scope / Trigger

Apply when scanning Pi JSONL, projecting history metadata, or deleting sessions.
A draft runtime key can remain `draft-session-*` after Pi assigns its persisted
ID; deleting the file while that runtime lives can let Pi recreate it by append,
without a session header. This is a possible corruption path, not proof of the
cause of every headerless file.

### 2. Signatures

- `ChatSessions::stop_session_file(project, session_path) -> Result<(), String>`
  takes the resolved session runtime project and finds its actual runtime keys,
  including starting processes.
- `session_delete(projectId, sessionPath)` remains the shared desktop/WebUI command.
- History responses add `headerMissing: boolean`; TypeScript accepts an omitted
  field from older Hosts as `false`. No database schema change is required.

### 3. Contracts

Only within the project's session directory, a standard Pi filename
`YYYY-MM-DDTHH-MM-SS-mmmZ_<UUID>.jsonl` plus a recognizable first parsed Pi message
(nonempty entry ID, role `user`/`assistant`/`toolResult`) permits an index-only
synthetic header. Preserve the title and preview from available records. Never
write that header to JSONL, invent missing ancestors, or override a real header's
mismatched `cwd`. Header probing remains bounded to 16 KiB.

History sets `headerMissing` unless its first parsed record is a `session` with
a nonempty string ID. Desktop and WebUI display an explicit warning and block
sending, deferred submissions, fork and model/thinking changes for such history.
WebUI must not start Pi as part of loading it. Index recovery enables listing and
`@` references, not native Pi resume or file repair.

Deletion resolves the indexed project/path first, stops matching Host runtimes
by their actual keys, checks the existing external-open-turn guard, then deletes
the file and cached index. Compare Windows local runtime paths as native paths
so Pi's backslashes match the index's mixed separators. This includes SSH
projects using Host-side Pi; keep remote path comparisons exact and leave the
indexed path unchanged for deletion. The external guard is heuristic; it does
not lock external Pi processes or serialize concurrent new starts. Unindexed
draft deletion uses its actual runtime key and preserves the open chat if
stopping fails.

### 4. Validation & Error Matrix

- Missing session directory or file (`NotFound`): treat as absent normally.
- Other directory enumeration error: fail the scan, preserving the old index.
- Observed file with unreadable/invalid header: keep its path in scan results;
  retain any previous scoped index row instead of treating parse failure as deletion.
- Unrecognized headerless filename/record: no synthetic new index entry.
- Stop failure or externally observed open turn: abort before deleting the file.
- Headerless history: view/reference only; native Pi may reject resume.

### 5. Good / Base / Bad Cases

- Good: a recognizable headerless file regains its title and `@` entry without
  modification; opening it shows read-only history on desktop and narrow WebUI.
- Base: valid headers retain normal indexing, resume and scoped deletion.
- Bad: a transient permission error removes a cached session, or deletion stops
  a nonexistent persisted-ID runtime while its draft-key process keeps writing.

### 6. Tests Required (When Authorized)

Pending explicit authorization; no tests added/run for this change. Cover standard
and invalid recovery filenames, BOM/blank/malformed prefixes, mismatched real cwd,
read-budget limits, title/first-message extraction, unreadable-row retention,
actual removal, full/windowed history flags, image offsets, desktop/WebUI deferred
send blocking, and deletion of draft-key and multiple matching runtimes. Include
mixed Windows separators under SSH with Host-side Pi. Assert stop failures
prevent deletion and original JSONL bytes stay unchanged by indexing.

### 7. Wrong vs Correct

Wrong: `stop(piSessionId)` followed by file deletion; silently discard every
unparseable file from a full scan.
Correct: `stop_session_file(runtime_project, session_path)` before deletion;
keep observed unreadable paths and recover only index metadata under the
contract above.

## Missing Session Title Recovery

### 1. Scope / Trigger

Session metadata indexing shared by desktop/WebUI and Local/WSL/SSH. Large
initial messages can place `session_info` outside the prefix and tail windows.

### 2. Signatures

- Server: `session.scan { project, known, summaryLimit?, paths? } -> SessionFile[]`.
- Host: `session_index::reconcile` and `reconcile_paths`; no SQLite schema changes.
- `known[]` adds optional `recoverName: boolean` (default `false`). Hosts set it
  for cached missing/blank names; older callers retain fingerprint-only behavior.

### 3. Contracts

Keep the 16/64/256 KiB progressive prefix and 32 KiB tail fast path. If the
resulting name is missing or blank, seek to byte zero and stream up to the
observed file size, applying complete `session_info` lines in file order.
Buffer at most 64 KiB plus a newline per line; skip oversized lines without
allocating their contents. Ignore incomplete final lines. The fallback does not
extract previews or parse full conversation history and never modifies JSONL.

Host sends all `known` fingerprints. A matching untitled fingerprint marked
`recoverName` is reusable only when Server has completed a title scan for that
snapshot and confirmed a missing/blank name. A recovered nonblank name must be
returned again until Host stores it, rather than acknowledged as unchanged.

Server keeps at most 256 title-scan entries, evicting the least recently used.
Entries contain only header, name, size/mtime and a 256-byte boundary sample,
not conversation history. Cache locks never span file I/O. Restart/eviction
permits one fresh full scan; no durable scan-version marker is required.

For append-only Pi JSONL, matching header and previous boundary allow reuse on
growth. Retain the bounded prefix/tail preview scan, then apply title metadata
from `oldSize - 64 KiB - 1` through the observed new size, dropping the first
partial line. This overlap recovers parseable lines split across writes, even
when the append exceeds the tail window. Same-size rewrites, shrinkage, header
changes or boundary changes discard progress. This is an append-only contract,
not a hash validation of arbitrary in-place rewrites followed by growth.
Cache a result only if final size/mtime still match the observed snapshot.

### 4. Validation & Error Matrix

- Fast scan finds a nonblank name without cached progress: retain the fast path.
- Name missing/blank without reusable progress: stream all metadata once.
- Matching completed untitled snapshot: return unchanged without opening the file.
- Cached snapshot grows: scan only the append plus bounded overlap; last name wins.
- Preserve byte-zero prefix scanning for synthetic/headerless sessions after seeks.
- Fallback/boundary seek/read/skip fails: return an error, not a partial index.

### 5. Good / Base / Bad Cases

- Good: title at 276 KiB in a 386 KiB session is recovered on refresh.
- Base: normal named sessions retain fingerprint-based cache reuse.
- Bad: widening a fixed window still misses later titles; unchanged fingerprints
  must not permanently preserve a missing-title result from the old scanner.

### 6. Regression Coverage

`crates/pilo-server/src/session/index/tests.rs` has 14 passing unit tests covering
hidden/latest titles, all prefix-stage boundaries, oversized lines, missing/blank
names, BOM/CRLF, exact 64 KiB JSON lines, incomplete final lines, snapshot limits,
read/seek/skip failures, headerless prefixes and growth before the final metadata
check. A tracked reader runs the production reader path and counts actual bytes:
named fast paths and cached snapshots stay bounded; appends read only windows
plus new bytes and overlap. Split-write coverage includes a maximum-size title
missing only its newline. Rewrites, shrinkage, header changes and boundary changes
must invalidate progress. Fixtures stay under `target/` and indexing preserves
their original JSONL bytes.

`crates/pilo-server/tests/session_index.rs` has 2 passing stdio integration tests
covering legacy fingerprints, deferred recovery, retries until Host stores a
recovered title, reuse of confirmed missing/blank names, restart recovery and
256-entry LRU eviction. Each child uses isolated agent/runtime directories.

Verified commands:

```bash
cargo test --locked -p pilo-server session::index::tests --lib
cargo test --locked -p pilo-server --test session_index
```

Desktop/WebUI visual checks and end-to-end watcher/Host persistence checks remain
manual and have not been performed for these regressions.

### 7. Wrong vs Correct

Wrong: consider fixed prefix/tail windows sufficient evidence that no title exists.
Correct: fast-scan first, recover missing metadata once, then reuse confirmed
snapshots and scan appends; old missing-title rows still get one recovery attempt.

## Shared Session Read Progress

### 1. Scope / Trigger

Desktop windows and Remote WebUI share Host-owned read progress. Apply this
contract when changing unread tracking, completion events or read-state APIs.

### 2. Signatures

- `session_read_states() -> SessionReadState[]`
- `session_mark_read(projectId, sessionPath, revision) -> SessionReadState`
- Authenticated `GET /api/v1/sessions/read-state` returns the same list; `POST`
  accepts `{ projectId, sessionPath, revision }` and returns one state.
- State: `{ projectId, sessionPath, completedRevision, readRevision }`.
- `session_read_state`: composite key `(project_id, session_path)`, project FK
  with cascading deletion, completed/read revisions. It does not require an
  indexed session: a new Pi chat may settle before indexing finishes.
- `session_read_revision`: one durable counter, allocated in the same immediate
  transaction as completion. Do not reset it when deleting sessions/projects.

### 3. Contracts

`ChatEventSink` records an active turn's `AssistantMessageEnd`, not process exit
or runtime failure. Desktop/WebUI external-activity polls share serialized
per-project observation: known open -> explicitly idle records completion;
a disappeared process does not. Unobserved external turns cannot be inferred.
SQLite runs in blocking workers, never on the Pi event stream's executor.

At completion, immediately broadcast global `session_turn_completed {
projectId, sessionPath, completionId }`. Its opaque random ID identifies the exact
turn, not a persisted revision. A single blocking worker preserves turn order
within each session, coalesces queued turns to the latest completion per session,
and broadcasts `session_read_state_changed { state, completionId }` after commit.
Ordinary read acknowledgements omit `completionId`. Both events
have no Pi generation and must bypass conversation/RPC reducers. Desktop uses
the existing global channel; WebUI consumes its existing socket rather than
creating another socket.

Read acknowledgement is monotonic and bounded by the supplied observed revision:
`read_revision = MAX(read_revision, MIN(requested, completed_revision))`. The
shared hook merges each revision by maximum to tolerate snapshot/replay/HTTP
reordering. Full snapshots remove absent records, except live updates received
after that snapshot request started. Discard superseded snapshot responses so
an older request cannot restore deleted records. Refresh on initialization,
foreground and WebUI recovery; `refreshKey` is an explicit effect generation.
Only the visible, focused client's selected session observes completion IDs.
Retain these observations across navigation/focus changes, then acknowledge only
the matching committed revision. Bound pending observations to 512 IDs if storage
repeatedly fails. Already committed selected sessions are acknowledged normally.
Selection itself is not synchronized. New completion revisions remain unread
until seen.
Sessions without a Host record retain legacy local tracking (including temporary
chats). Existing historical turns are not retroactively marked unread.

### 4. Validation & Error Matrix

- Zero, negative, fractional or unsafe JS revision: reject; never clear a turn.
- Unknown project/path record: reject acknowledgement; never create a record.
- DB failure: report failure, do not broadcast an acknowledgement.
- Old acknowledgement after a newer completion: newer completion stays unread.
- Session deletion: remove its scoped read state; project deletion cascades.

### 5. Good / Base / Bad Cases

- Good: open a completed Host chat on WebUI; every desktop window clears its dot.
- Base: restart/refresh loads persisted progress; temporary chats remain local.
- Bad: an old HTTP reply or replay must not restore a cleared dot or read a new turn.

### 6. Required Verification (When Authorized)

Cover both read directions, two desktop windows, refresh/restart, foreground and
reconnect, hidden clients, acknowledgement racing a new completion, reversed
snapshot/event delivery, completion observed before a delayed commit followed
by navigation/blur, consecutive completions racing acknowledgement, overlapping
snapshots and deletion with a live event in flight, colliding project paths,
delete/recreate revision allocation, external open/idle/disappearance and SQLite
failure. No historical
conversation payload is copied into read-state storage.

### 7. Wrong vs Correct

Wrong: persist a boolean, use Pi process generation as a turn ID, or synchronize
which session is selected. Correct: persist Host-issued completion/read revisions
and acknowledge only the revision actually observed by the focused client.

## Shared Theme Settings

### 1. Scope / Trigger

Host-owned appearance shared by desktop windows and authenticated WebUI.

### 2. Signatures

- SQLite `theme_settings(id INTEGER PRIMARY KEY CHECK(id = 1), settings_json TEXT)`.
- `theme_settings_get(initial?: ThemeSettings) -> ThemeSettings` (desktop IPC).
- `theme_settings_set(update: ThemeSettingsUpdate) -> ThemeSettings` (desktop IPC).
- Authenticated `GET /api/v1/theme -> ThemeSettings` and `POST /api/v1/theme`
  with a `ThemeSettingsUpdate` body -> committed `ThemeSettings`.
- `PiloClient.loadThemeSettings()` / `saveThemeSettings(update)` expose the same
  snapshot and patch transport contracts. The authenticated HTTP write endpoint
  remains available, but WebUI has no theme editing UI and does not call it.
- Global `theme_settings_changed { settings }` uses the existing runtime bus.
- Settings: `{ revision, theme, themeFamily, themeCustomCss, themeCustomName,
  savedCustomThemes: [{ name, css }] }`. Mode is light/dark/system; family is
  lody/claude/custom. Updates contain optional mode/family/CSS/name fields plus
  `saveCustomTheme: { name, css }` or `deleteCustomTheme: string`.

### 3. Contracts

Initialize with idempotent DDL. Only desktop supplies legacy initial settings;
insert revision 1 with `ON CONFLICT DO NOTHING`, never replace an existing row.
A Web read before initialization returns defaults at revision 0 without inserting.
Patches read/merge/write in an immediate transaction, increment revision and
broadcast only after commit. Save/delete actions merge against the persisted
custom-theme list, not a stale window snapshot. Saving trims/requires a name,
replaces an exact-name saved theme and sets active CSS/name. Deleting preserves
active CSS, matching existing behavior. SQLite runs in blocking workers.
Clients discard equal/older revisions; startup caches are never authoritative.
Desktop serializes its writes and applies responses only after persistence
succeeds. Selecting a saved theme patches family, CSS and name in one request,
not separate writes. `AppearanceSettings` is desktop-only; WebUI has no theme
settings entry, editor or switching controls in either wide or mobile layouts.
WebUI follows the Host through authenticated snapshot reads and existing global
theme events, with refresh on initialization, reconnect/resync and foreground.
Clean desktop CSS/name drafts follow other windows' changes; unsaved local drafts
are preserved. Global theme events bypass conversation reducers. Font settings
remain local.

### 4. Validation & Error Matrix

- Unknown mode/family/update fields: reject at serde decoding.
- Blank saved-theme name: error, transaction rolls back.
- Load failure: IPC error or HTTP 500. Save failure: IPC error or HTTP 400
  (the existing remote settings-write convention); no change event for a failed write.
- Missing/expired Web token: existing authenticated-route 401 handling.

### 5. Good / Base / Bad Cases

- Good: desktop switches a built-in/custom theme; other desktop windows and
  connected wide/mobile WebUI clients follow without WebUI editing controls.
- Base: restart/refresh reads SQLite; legacy desktop themes migrate once.
- Bad: stale browser settings overwrite an existing row, or an old HTTP/event
  snapshot reverts a newer revision.

### 6. Tests Required

Pending explicit authorization (no tests added/run): migration idempotency and
legacy theme retention; restart persistence; concurrent field patches and
save/delete merges; unknown enums and blank-name rollback; failed commit emits
nothing; snapshot/replay reordering; reconnect/foreground recovery; custom CSS
removal on family change; desktop edits synchronizing to other desktop windows,
wide WebUI and mobile WebUI; no WebUI theme editing/switching controls;
authenticated-only writes; atomic saved-theme selection; clean desktop draft
synchronization and dirty draft preservation.

### 7. Wrong vs Correct

Wrong: synchronize theme via browser `storage` events or persist fonts with it.
Correct: SQLite theme patches -> committed revision -> existing desktop/Web event
channel, with authenticated snapshot reads for recovery.

## Testing

Storage unit tests live in `src-tauri/src/runtime/storage.rs` under `#[cfg(test)]`
and use `SqliteConnection::open_in_memory()`. Add an in-memory test for every
new storage function.
