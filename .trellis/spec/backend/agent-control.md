# Pilo CLI (Local Host Client)

> Status: contract for `.trellis/tasks/11-27-pilo-cli`. The CLI itself, the
> local IPC endpoint and the desktop "CLI" settings page are implemented in
> separate steps; this file is the source of truth for their contracts. The
> former `pilo-server ctl` agent control path has been removed.

## Scope and ownership

`pilo` (`crates/pilo-cli`) is a short-lived Rust client and the third Host
client beside the desktop UI and Remote WebUI. It never opens SQLite, starts
Pi or creates a `Runtime`. The desktop process still owns the single embedded
Host. Desktop `NativeTransport`, remote `HttpTransport` and CLI IPC dispatch to
the same Host API v2 method table and handlers in
`crates/pilo-runtime/src/host_api/`. Remote WebUI HTTP/WS, device pairing and
scopes are unchanged.

The former session/settings handlers in `runtime/control/{sessions,settings,catalog}.rs`
are business code only; the CLI migration reuses or replaces them. They must
not depend on a lease or a calling Pi session to resolve targets.

## Instances

- The default instance is compiled in from `PILO_CLI_APP_ID` (`option_env!`):
  release packages ship `pilo` with `app.hsingjui.pilo`; dev packages ship
  `pilo-dev` with `app.hsingjui.pilo.dev`. Unset (local builds) means
  `app.hsingjui.pilo.dev`. `--dev` overrides to the dev instance.
- Never infer the instance from `argv[0]` or `debug_assertions`, and never fall
  back to the other instance after a connection failure.

## Local IPC

- No TCP port, token, pairing or confirmation; the OS user boundary is the
  authorization. Host verifies the peer OS identity and grants
  `Principal::Local`; clients cannot claim a principal. The Remote WebUI switch
  does not affect IPC.
- Endpoints (Host and CLI derive the same path; no discovery file):
  - macOS: `~/Library/Application Support/<app id>/pilo.sock`
  - Linux: `$XDG_RUNTIME_DIR/pilo/<app id>.sock`
  - Unix fallback when the path exceeds 100 bytes or Linux has no
    `XDG_RUNTIME_DIR`: `/tmp/pilo-<uid>/<app id>.sock`. Socket mode `0600`,
    fallback directory `0700`; Host verifies it is owned by the current user and
    is not a symlink. Only a stale own socket that refuses connections may be
    rebound; never delete a live endpoint.
  - Windows: `\\.\pipe\pilo-<app id>-<user SID>`, ACL current user only,
    remote clients rejected.
- Host creates and removes the endpoint; a real app exit closes it, hiding the
  window does not.

### Frames and handshake

- Frame: 4-byte big-endian unsigned length + UTF-8 JSON. Length counts JSON
  bytes only, max 16 MiB; reject oversized declarations before reading the body.
- Hello (5 s limit): CLI sends
  `{"protocol":"2.0","client":"pilo-cli","version":"<cli version>"}`; Host
  replies `{hostId, appVersion, capabilities, installation:{source,path}}`.
  Incompatible major protocol is an explicit error; same-major patch drift is
  accepted. `installation.source` is `installed`, `portable` or `appimage`;
  `path` is the canonical app path (macOS `.app`, app directory, or the original
  AppImage file). `hostId` cannot distinguish installed vs portable copies.
- Request `{id, method, params}` mirrors `/api/v2/call`; response is
  `{id, result}` or `{id, error:{code,message}}`. Default request timeout 60 s,
  `--timeout` overrides it (not the hello limit). `{event}` frames are reserved
  for a future `sessions send --wait` and are not sent. Never replay a
  submitted write after a disconnect; retries happen only during connect/hello.

## Commands

| Command | Host API / semantics |
| --- | --- |
| `settings get\|patch`, `settings theme get\|set` | `preferences.get/patch`, `theme.get/set`; field-level patches, never file writes. |
| `projects list\|add\|remove` | `project.list/add/remove`; add uses the connection's path validation and workspace lifecycle. |
| `sessions list\|get\|history` | `session.list/history`, `chat.state`; IDs resolve within a project, never arbitrary JSONL paths; bounded pagination. |
| `sessions status <id>` | One snapshot from `chat.state` + `chat.transcript` / `session.history`; never starts Pi. |
| `sessions create\|send\|abort\|stop` | `chat.start/rpc/stop` with the shared create/first-prompt semantics. |
| `sessions archive\|restore\|delete\|update` | `session.uiState.set` with `archived: true/false`; update patches title/pin without rewriting omitted fields; delete uses Host trash, never unlink. |
| `open [path]`, `open --session <id>`, `version`, `--help` | OS open/activate; navigation only with a target; `version`/`--help` need no Host. |

- `create`/`send` read stdin JSON (`{"message":"…","title":"…"}`, `title` only
  for create). Reject blank messages, slash commands and busy targets; never
  queue silently. `create` reports acceptance only after Pi's correlated reply
  to the first prompt, not after generation. Explicit non-submission/rejection
  stops the new process; an unknown outcome keeps the session and returns a
  queryable key. `send` can resume a saved session. `abort` interrupts a turn;
  `stop` closes the managed process and keeps history. `archive` is not
  `delete`; delete never implicitly stops a managed session.
- Output: success prints exactly one JSON value on stdout and exits 0; errors
  exit nonzero with diagnostics on stderr. `--help` is text. `version` prints
  `{"cli":"<version>","appId":"<app id>"}`. Error classes distinguish offline,
  incompatible protocol, invalid input, explicit rejection and unknown write
  outcome (suggest querying, not retrying).
- First-release `settings` covers preferences and theme only. Desktop-native
  settings (exit behavior, global shortcuts, autostart) stay in the desktop
  native bridge. No generic `pilo api`/invoke; never print credentials.

### `sessions status`

Resolves the session through the Host index and reads existing Host state only:
no Pi start/resume, no subscription, no JSONL tailing. Fields are always present:

| Field | Meaning |
| --- | --- |
| `sessionId` | Resolved full session ID. |
| `state` | `idle`, `running`, `compacting`, `not_running`, `error`. Process failure → `error`; no managed/stopped process → `not_running`; compacting wins over an active turn; active turn or starting Pi → `running`; otherwise `idle`. |
| `turn` | `idle`, `active`, `truncated` or `null` (`chat.transcript.live.type`; `null` without a snapshot). |
| `runningTools` | Tool names matched by call ID in the full current turn; `[]` when known idle; `null` when truncated/unavailable. Never guess. |
| `lastAssistantMessage` | Text of the latest completed assistant message from history, or `null`. |

`state: "error"` is a successful query of a failed session. Host offline,
unknown session or query failure are command errors, not `not_running`.

## Open and launch

- `pilo open` starts or activates the app associated with the PATH entry, waits
  for hello and compares `installation` with that entry. A missing target asks
  for repair; another running copy with the same app ID must be quit first.
  Never navigate, report success or fall back to another copy on mismatch.
- `pilo open <path>` resolves relative to the caller's cwd; Host canonicalizes
  and matches Local projects, adding unregistered directories via
  `project.add`. `pilo open --session <id>` accepts a full ID or unique prefix,
  lists candidates when ambiguous, rejects JSONL paths and cannot be combined
  with a path. Navigation is sent over IPC after the installation check, not via
  `secondInstance` arguments (macOS does not emit that event).
- Other commands never start the app unless `--launch` is given; then they wait
  a bounded time for hello, verify the installation and execute exactly once.
  Offline without `--launch` prints a hint to run `pilo open`.
- The CLI's own copy is the `.app` holding `Contents/Resources/bin/`, the app
  directory holding `bin/` beside `Pilo[.exe]`, or the AppImage recorded for
  the persistent copy in `<data>/<app id>/cli-install.json`. `--dev` from a
  release CLI cannot open or launch (it has no dev copy to verify).
- `desktop.open {path?, sessionId?}` (`Scope::Admin`, local only) resolves the
  target, queues it for the desktop window and returns only after the window's
  receipt: `{projectId, project, path, added}` or, for sessions, `{projectId,
  project, path, sessionId, sessionPath}`. The window waits up to 30 s to start
  serving navigations and 30 s to answer; requests whose caller gave up are
  dropped, not applied late. The window switches to the local Host before
  selecting, never to a remote Host or the Remote WebUI.
- CLI codes: `app_not_found` / `installation_mismatch` (rejected),
  `launch_failed` / `launch_timeout` (offline; launch waits 30 s for hello and
  retries only connect + hello). Ambiguous prefixes are `conflict` listing up
  to 10 candidates; no match is `not_found`.

## Installation

The CLI ships inside the app (`Contents/Resources/bin/` on macOS, `bin/` beside
the executable on Windows/Linux; never mixed with `runtime/pilo-server-*`) and
updates with it. The desktop-only "Settings → Other → CLI" page installs,
uninstalls and repairs it: macOS `/usr/local/bin/pilo` symlink with one admin
authorization (fallback `~/.local/bin` on cancel), Linux `~/.local/bin` (AppImage
links to a persistent copy in `~/.local/share/pilo/bin/`), Windows adds the app's
`bin` directory to the user PATH (no `pilo.cmd`). Install/uninstall/repair are
idempotent, verify ownership, never overwrite third-party entries and report
PATH shadowing. Remote WebUI never shows this page.

## Removed: `pilo-server ctl`

- There is no `ctl` subcommand, no `control.register/respond/revoke` protocol
  messages or capabilities, no loopback control listener, no Host control
  lease/dispatcher, no Pi system-prompt hint and no `PILO_CTL` /
  `PILO_CONTROL_*` / `PILO_REMOTE_CONTROL` injection (including the SSH
  workspace bash wrapper). Any positional first argument, including `ctl`,
  exits 2 with `unknown pilo-server command` on stderr; there is no
  compatibility entry.
- stdio Server, `--version`, `--fingerprint`, `--ssh-bridge`/`--ssh-daemon`
  and Pi session behavior are unchanged.
- Pi running inside SSH/WSL loses Host self-control and no forwarding is
  provided. Local Pi can run the PATH `pilo` with the same permissions as the
  user's terminal. The local CLI still manages Host-managed SSH/WSL projects.
- Wrong: reintroduce per-session capabilities, env-var tokens or a remote
  forwarding shim. Correct: call the local Host only through the CLI IPC.

## Shared preferences and events

- `preferences` is one Host SQLite row: revision, sparse initialized values and
  a desktop-migration marker. Defaults/validation live in `runtime/preferences.rs`.
  Unknown keys and invalid enum/font-size/shortcut values fail before persistence.
- Use an immediate transaction for field patches and monotonically increasing
  revisions. Nested shortcut maps patch individual command bindings; complete
  snapshots merge current defaults. A CLI-first shortcut write must not mark
  unrelated bindings initialized.
- Only desktop imports old preferences/locale, once. Host-initialized fields and
  individual shortcut bindings win; migration fills gaps. Conflicting legacy
  shortcuts are unbound instead of overriding an initialized Host binding.
  WebUI never imports local browser settings into Host.
- `preferences_get` / `preferences_patch` and authenticated
  `POST /api/v2/call/preferences.get` / `POST /api/v2/call/preferences.patch`
  share the same validation/storage implementation. Theme keeps its existing storage and
  revision rather than being duplicated in this table.
- Committed preference changes publish `preferences_changed { settings }`.
  Connections/projects/native mutations publish `configuration_changed`; existing
  scoped events remain in use for model scope, prediction, enhancement and cache
  policy. Desktop and WebUI must refresh after external changes and reconnect.

## Preference recovery and shortcut atomicity

### 1. Scope / trigger

Desktop legacy import, desktop/WebUI preference recovery, and concurrent CLI/UI
application/global shortcut changes share these contracts.

### 2. Signatures

`validate_application_shortcut(&str) -> Result<String, String>` returns a comparison
identity; `preferences::save(..., migrate: bool)` keeps normal writes strict.
`refreshHostPreferences()` recovers the current transport's readiness.
`desktop_shortcut_set(...)` owns native registration and the conflict transaction.

### 3. Contracts

Application bindings use `KeyboardEvent.key`: preserve printable characters such
as `mod+shift+?` and Unicode rather than requiring a native key code. Native keys
retain native comparison identities; other printable keys compare normalized
modifiers and lowercase characters. Persist the original binding, not its identity.
Only legacy import replaces an invalid binding with an empty (unbound) string;
Host-initialized fields still win. A successful reload restores readiness only for
the same transport binding, without replaying failed writes. Read current application
bindings and reject global conflicts inside the setter's immediate transaction,
before changing OS registration; the CLI must not substitute an earlier preflight.

### 4. Validation / error matrix

Unsafe/malformed/oversized bindings still fail ordinary patches. Legacy import
unbinds those individual entries while importing the remaining preferences. Load
failures remain visible; a failed refresh does not restore readiness. A conflicting
global write leaves the database and OS registration unchanged.

### 5. Good / base / bad cases

Good: preserve `mod+shift+?` on import, then save after a transient load failure and
successful refresh. Base: existing native-key bindings and write serialization are
unchanged. Bad: reject all legacy preferences for one invalid binding, retain a
rejected readiness promise after recovery, or check collisions before acquiring
the write transaction.

### 6. Tests required

Pending explicit authorization: assert printable/Unicode import preservation,
invalid-legacy unbinding, strict invalid ordinary patches, and Host-first migration.
Reject initialization, refresh successfully, then assert a new patch succeeds and
no failed write is replayed; an obsolete binding's refresh must not unlock the new
Host. Race application/global assignments to the same key in both orders; assert
only one commits and rejected native changes preserve the old registration.
This review follow-up has not run tests, builds or live UI verification.

### 7. Wrong vs correct

Wrong: use native key-code parsing as the only application validator or keep a CLI
conflict preflight outside the setter. Correct: support printable application keys,
sanitize legacy entries individually, recover readiness from successful reloads,
and enforce the conflict invariant inside the shared write transaction.
