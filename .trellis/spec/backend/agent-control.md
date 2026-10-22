# Built-in Agent Control

## Scope and ownership

Interactive Pi sessions can query and change Pilo settings and add an existing
project through `pilo-server ctl`. This is not an arbitrary Tauri/SQL bridge and
does not create a second daemon. Host owns authorization, target resolution and
business operations; Server forwards bounded control messages only.

Implementation: `crates/pilo-protocol/src/control.rs`,
`crates/pilo-server/src/control.rs`, `runtime/control.rs` and
`runtime/control/{catalog,settings}.rs`.

## Contract

- No arguments still starts the stdio Server. `--version` / `--fingerprint`
  retain their behavior. `ctl` runs once, prints JSON to stdout and diagnostics
  to stderr, and exits nonzero on failure. `--json` is accepted; output is
  always JSON. A missing Host/context is an error, not a daemon startup.
- Commands: `status`, `settings list/get/set/reset`, `connections list/save`,
  `projects list/add`. `settings set KEY JSON` accepts one JSON argument or
  `--stdin`; `connections save` requires `--stdin` even for nonsecret edits.
  Cache-policy reset also needs explicit provider/model identity as JSON.
- `settings list` describes keys, defaults, constraints, scope, read-only or
  action behavior, platform and the connection-save input schema. Never infer
  a setter from a key or expose arbitrary `invoke`/Pi configuration files.
- Connection/project settings require explicit `--connection` / `--project`.
  `projects add PATH --connection ID` interprets PATH in the target environment.
  It uses `project::add` inspection/upsert followed by `open_project` and a
  Runtime change event. It never creates directories or copies source code.
- Connection save reuses SSH/WSL setters and the home-visibility setter; Local
  retains reserved ID `local` and workspace runtime. An existing connection
  cannot change its kind. Saved credential readback is only `hasPassword`.
  Connection removal is not exposed: its existing implementation cascades
  project removal, which is outside this control API's scope.
- Native settings invoke the existing autostart/tray/shortcut/remote manager
  implementation. Return native errors, not synthetic success. Notifications
  report a saved preference; OS/browser permission is still required.
  Remote pairing URLs/tokens are never returned as ordinary settings.

## CLI argument and single-field validation

- Scope / trigger: validate CLI grammar in `pilo-server::control::run_cli` and
  field semantics in Host `runtime/control/settings.rs`, before persistence.
  Do not tighten the shared `ThemeSettingsUpdate` patch API to fix CLI inputs.
- Signatures: `ctl ... --connection ID --project ID`; `settings set KEY JSON`
  or `--stdin`; ordinary `settings reset KEY` takes no JSON. Only
  `settings reset connection.cacheKeepAlive JSON` (or `--stdin`) takes an
  identity payload containing `provider` and `modelId`.
- Contract: target IDs cannot be blank or start with `-`; a following option
  must not be consumed as an ID. All theme field/action writes require non-null
  values. Host also rejects non-null ordinary-reset payloads from raw control
  commands, even if the CLI grammar is bypassed.
- Validation / error matrix: missing/option-like ID, extra ordinary-reset JSON
  (including `null` or stdin), and null theme values exit nonzero with stderr
  and no stdout. They must not save a no-op or advance a revision.
- Good / base / bad: cache reset with explicit identity succeeds; ordinary
  preference and theme resets keep their defaults; `status --connection --json`,
  `settings set theme.theme null` and `settings reset preferences.uiFontSize false`
  fail. A partial theme patch remains valid outside this CLI setter.
- Tests / assertions: real managed-session probes passed the original 223
  negative/security checks plus 20 additional boundary/positive checks. Assert
  unchanged preference/theme snapshots **including revisions** after rejected
  commands, positional and stdin cache resets, restored effective values after
  successful writes, and invalid capability after stopping the test session.
  Rust formatting, workspace check and all-target/all-feature Clippy passed.
  No repository test-suite source was changed.
- Wrong vs correct: treating `Option<T>` deserialization as validation of a
  required single field permits false success for null. Check the required
  CLI value before constructing the existing patch object instead.

## Identity and transport

- Each managed Server binds an ephemeral IPv4 loopback TCP endpoint. Frames are
  newline-delimited JSON with a 1 MiB limit; there is no public HTTP management
  listener. The existing WebUI HTTP API keeps its pairing middleware.
- Host subscribes to a unique control stream before registering a 256-bit
  random token. The stream identifies the source using Host project storage,
  not caller-provided source IDs. Only explicitly controlled interactive
  launches receive `PILO_CTL`, `PILO_CONTROL_ENDPOINT`, `PILO_CONTROL_TOKEN`.
  Model-catalog and other background launches do not receive a capability;
  inherited control variables are removed before spawning Pi.
- `control.request` uses a dedicated subscription, never the Pi event stream's
  single receiver. Host dispatches off the transport reader, so a setter can
  call the same Server without deadlocking.
- Registration/respond/revoke are synchronous protocol state operations handled
  in input order. In particular, cancellation must not allow a queued revoke
  to run before registration and leave a live capability behind.
- Bounds: 256 contexts/Server, 32 accepted sockets, 64 pending requests/Server,
  16 executing requests/Host control stream, five seconds to read the initial
  authenticated frame and 60 seconds for a Server call. Host execution times
  out at 55 seconds; the CLI waits at most 65 seconds for the result.
- A pending-request guard removes requests on disconnect, timeout or cancellation.
  Process exit and `pi.stop` revoke the local context; Host lease cleanup also
  revokes mixed-SSH contexts. Dropping the Host dispatcher aborts its work.
  Server/Host exit invalidates contexts. No writes are automatically replayed;
  timeout/disconnect can mean the write outcome is unknown.

## Local / WSL / SSH

Use the managed Server deployment and connection pool, never a globally installed
CLI or guessed localhost instance. Multiple instances/dev-release builds get
different endpoints and tokens. Windows debug GUI processes cannot supply a
console CLI: `scripts/tauri.mjs` builds the adjacent `pilo-server.exe` before
Windows development launch. Release uses its existing bundled console Server.

For local Pi with an SSH workspace, Host also registers a lease on the workspace's
managed remote Server. `PILO_REMOTE_CONTROL` reaches the built-in SSH extension;
its wrapper exports the remote executable and capability in the remote bash.
The script travels over SSH stdin (`bash -s`), not SSH/shell argv. Strip control
environment variables from the local SSH subprocess environment. Remote Pi is
not required for this path.

Tokens must not appear in normal output, trace events, process arguments or
connection queries. Passwords enter through stdin and the existing system
credential store. This is instance/session binding, not a promise of isolation
from malicious processes running as the same OS user.

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
  `GET/POST /api/v1/preferences` share the same validation/storage implementation.
  HTTP cannot request desktop migration. Theme keeps its existing storage and
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
before changing OS registration; CLI must not substitute an earlier preflight.

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

## Verification status and required cases

With user authorization, the Windows debug Host and Linux debug Server were
built and connected through WSL. A temporary `noSession` Pi session executed the
real injected CLI (no direct database writes or substitute control dispatcher).
Live verification covered 32 settings and 47 distinct checks:

- All 17 preferences and four theme fields: CLI write/readback, desktop WebView
  state, and an authenticated headless WebUI at 390×844. Locale, UI/code font
  sizing and theme mode also changed the live DOM/CSS without a reload. Plugin
  notifications were checked on desktop only. Custom theme CSS was additionally
  checked as applied computed style on desktop.
- Desktop autostart/exit-on-close/global-shortcut settings, four connection
  settings, project model scope and three remote settings: CLI readback and
  desktop `configuration_changed` delivery. Remote port changes and stop/start
  were checked against the live HTTP health endpoint. A cleared naming model
  reads back as JSON null, not an object with nullable fields.
- Invalid font size, locale, boolean type, shortcut command, theme enum, reserved
  remote port, missing target and shortcut collision were rejected; preference
  reset returned its default. Mobile WebUI had no horizontal overflow.
- All effective setting values were restored (revision/update metadata naturally
  advance on writes). The temporary Pi session was stopped and only the browser
  device created for this verification was revoked. Existing devices and the
  installed release instance were not modified.

Frontend type-check/build, `pnpm check`, Rust formatting, Linux Server build,
Windows dev startup and the 21 existing conversation-reducer tests passed.
The lint follow-up fixed the WebUI callback dependency and preference accumulator;
intentional external refresh dependencies use the existing narrowly scoped,
explained `react/exhaustive-effect-dependencies` exception pattern. Global lint
rules remain enabled. That follow-up did not rerun interactive UI verification.
No test-suite source files were changed. Diagnostic logs are under `logs/` and
local probe artifacts under `.tmp/cli-settings-check/` (both ignored).

This does not verify notification delivery/permission, a real login/autostart,
global-shortcut key delivery, actual model responses, or every open settings
panel. Additional authorized negative checks covered malformed/oversized frames,
unavailable Host, invalid/revoked capabilities, and native CLI timeout without
retry. Remaining cases include old startup/version/fingerprint; actual
wrong-instance capabilities; bounded
concurrency and cancellation; four runtime modes including mixed SSH without Pi;
cross-connection project addition with stable IDs; CLI-first and desktop-first
migration; nested concurrent patches; reconnect and stale revisions; actual
native errors/notification permission; and absence of secrets in argv/events.

Wrong: copy full browser preference snapshots on reconnect, replay a timed-out
write, use Pi's stream subscriber for reverse control, or return pairing tokens.
Correct: load Host snapshots, submit only changed fields, use independent control
streams, and retain existing native/system authentication boundaries.
