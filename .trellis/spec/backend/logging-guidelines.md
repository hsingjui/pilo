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
back into the webview. This target also rejects `tauri_runtime_wry*` records:
`app.emit("log://log", ...)` evaluates JavaScript, and an invalid/closing WebView
can log that evaluation failure through `tauri_runtime_wry`. Forwarding that error
back to the same WebView creates an unbounded log/eval feedback loop. Apply this
filter only to the Webview target, never globally; file and stdout diagnostics
must retain runtime errors. When Windows verification is authorized, confirm an
unavailable WebView cannot amplify one runtime error into repeated log delivery.

The About settings page opens the same directory with `appLogDir()` and the
`opener` plugin. Scope `opener:allow-open-path` to `$APPLOG`; the bare command
permission exposes the command but still rejects the path. Do not duplicate the
path calculation in Rust or TypeScript.

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
  duplicate its raw message. Correlated runtime diagnostic metadata is an
  intentional exception: each transport boundary may record its own stage.
- Do not add per-message logs on hot paths (streaming, virtualization, session
  parsing). Bounded lifecycle/RPC summaries are allowed as described below.
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

## Runtime Timeout Diagnostics

### 1. Scope / Trigger

Use for startup/RPC timeouts, shared server failures, and stalled Desktop/WebUI
streams. Keep timeout, retry, teardown, and public error behavior unchanged.

### 2. Signatures

- `runtime_trace(stage, session_key, stream_id, detail)` keeps the existing debug
  JSONL trace and emits selected metadata to the rotated desktop log in release.
- `debug_runtime_trace_log(payload)` accepts frontend trace JSON in all builds.
  `append_frontend_trace` uses the same metadata allowlist; it is not a generic
  release logger for arbitrary frontend objects.

### 3. Contracts

- `runtime-diagnostics` records include desktop PID, source, stage, session key,
  stream ID, and allowlisted scalar metadata. Never persist `error`, `message`,
  command bodies, tool arguments/results, or authentication objects here.
- Correlate `webview.rpc.begin/end`, `chat.send.*`, `server_pi.recv` responses,
  `channel.send`, and `webview.recv` by the Pi RPC `id`. Initialization uses
  `chat.control.begin/sent/end`, with `timeoutMs`, `elapsedMs`, and `timedOut`.
- Session mutex acquisition records `lockWaitMs`; client transport summaries
  record envelope `requestId`, method, RPC ID, elapsed/enqueue time, queue capacity,
  and pending request count on timeout. `launcherPid` is the Windows/SSH launcher
  child, not necessarily the environment's actual server PID.
- `channel.send` includes Channel ID, runtime replay `sequence` and serialized
  `payloadBytes`; frontend receipt also records its Channel ID. This sequence
  is **not** the Tauri Channel's internal message index.
- Persist process state, RPC response, runtime error code and final assistant
  completion metadata, not text/thinking deltas or tool update events.
- Desktop timeout warnings include `sendCompleted`, `responseReceived`, channel
  ID, received event count, last-event age/type and last session event type.
  Receipt without successful command transport can still time out; log both flags.
- Server diagnostics go to stderr only: actual PID/version, Pi child lifecycle,
  write timeout/I/O kind, request capacity exhaustion/admission delay, task
  panic/cancellation, failed or >=5-second requests, stdout/stdin closure and
  cleanup. Desktop captures this stderr in the existing `pilo-server` target.
- Prediction uses bounded `next_prompt.*` stages in release too: Host readiness,
  result and policy rejection, plus shared frontend request/result/skip/discard/
  cancel/release/timeout/rejected decisions. Correlate by request ID and stream ID.
  Extension result projection accepts one JSON line up to 4,096 bytes and only
  bounded ASCII identifier/reason/status/stop-reason strings and unsigned
  revision/elapsed/output-token/reasoning-token numbers. Never pass the whole
  Widget result or raw provider error to tracing. Absent usage stays unknown;
  reasoning tokens are already included in output tokens. A release after a
  received result is not a cancellation of pending generation. WebUI client
  decisions stay in its console; Host result/rejection records persist for both
  clients. See [Next Prompt](./next-prompt-and-extensions.md).
- Model refresh uses bounded `model_catalog.*` stages: shared frontend prepare,
  commands, extension versus RPC fallback, scope/thinking probes, persistence,
  cleanup and total time; Host launch resolution, Server readiness and process
  spawn; connection settings catalog reads and cleanup. Record `elapsedMs`,
  success, counts and catalog source, never model/config/auth objects. Desktop
  frontend stages use `debug_runtime_trace_log` and the same release allowlist;
  WebUI frontend stages stay in its console. Existing `chat.control.*` stages
  identify the wait for Pi's initial `get_state`; process spawn ACK is not Pi
  readiness. Correlate by probe session key/project and stream ID.
- WebUI browser timeout warnings include RPC/session IDs, elapsed time, command
  transport completion, pending count and last socket sequence/message age.
  These warnings stay in the browser console; shared Host stages and socket
  open/close/replay-gap/lag/send errors are persisted in the desktop log.

### 4. Validation & Error Matrix

- Missing RPC reply -> timeout metadata; preserve the existing caller error.
- Transport loss -> pending count and affected stream count plus I/O reason.
- Stream overflow -> stream ID, event size and remaining queue/byte capacity.
- Web replay gap/lag -> device ID and sequence context; no token or event body.
- Normal deltas/tool updates -> no release per-event diagnostic log.
- Prediction command `success: true` -> accepted only; use `next_prompt.result`
  status/reason/usage and `next_prompt.client.result/discard` to explain no hint.

### 5. Good / Base / Bad Cases

- Good: response received by Host and sent to a window, but absent from
  `webview.recv`, identifies the Desktop delivery boundary as suspect.
- Base: a single Pi initialization times out while other sessions keep delivering.
- Bad: infer that a caller timeout itself killed all sessions, or log raw RPC data.

### 6. Coverage When Requested

Assert allowlisting drops body/error/auth fields, release logs preserve matching
RPC IDs, timeout flags distinguish transport and response completion, and normal
streaming produces no per-delta records. Exercise Desktop and WebUI separately;
WebUI console warnings are not automatically forwarded to the Host log.

### 7. Wrong vs Correct

- Wrong: promote every debug trace or dump `RuntimeEvent`/command JSON to release.
- Correct: reuse the shared stage filter and scalar allowlist, recording only
  boundary metadata while retaining existing log rotation limits.

## Connection Startup Diagnostics

### 1. Scope / Trigger

Local/WSL/SSH server startup, including connection tests and failures before a
server exists. Host-side diagnostics serve both Desktop and WebUI callers.

### 2. Signatures

- `ConnectionDiagnostics::new(connection)` creates a process-local `attemptId`.
- `stage(name).finish(Result<T, String>)` records begin/end without changing the
  result; dropping an unfinished stage records `stage interrupted`.
- `process_exit(stage, Option<ExitStatus>, stderr)` and `io_error(stage, error)`
  record exit status or native I/O kind/code, never the raw error payload.

### 3. Contracts

- The `connection-diagnostics` target uses the existing rotated desktop log.
  Correlate stages with `attemptId` and the context record's host PID/connection
  ID. Context includes Pilo version, host OS/architecture, connection kind,
  SSH mode/auth method, explicit proxy-jump presence and Pi runtime location.
  Proxy-jump presence reflects direct settings, not resolved OpenSSH config.
- Stages are `connect`, `prepare_server`, `platform_probe`, `artifact`, `deploy`,
  SSH `upload`/`install`, `spawn` and `handshake`. End records include `ok`,
  `elapsedMs` and a fixed `reason`; interrupts do not imply authentication failure.
- Keep existing command arguments, timeout durations, retries and returned errors.
  Failure labels are diagnostic hints only, not the frontend error classifier.
- Credential operations record connection ID, operation, duration and a fixed
  keyring error variant label. Routine `has_ssh_password` reads stay quiet.
  Never format a keyring error with `Debug` or log its payload/password.
- SSH launchers receive `PILO_SSH_DIAGNOSTIC_ATTEMPT_ID`. Only askpass children
  with a valid numeric attempt ID emit `[pilo-ssh-askpass]` metadata on stderr:
  they exit before Tauri logging initializes. Other askpass callers stay quiet.
  Keep stdout exclusively for the password. Probe/deploy summaries project these
  records into `askpassOk`/`reason`, then strip them from returned error text.
  `askpassOk=None` means no diagnostic report, not proof the helper never ran.
- New diagnostics emit fixed failure labels, exit codes, I/O kinds/OS codes and
  byte counts, not arbitrary remote stdout/stderr, commands, hosts, usernames,
  private-key paths or credential contents. Unknown failures use `unclassified`.

### 4. Validation & Error Matrix

- Credential access failure -> keyring variant label; preserve command errors.
- Askpass read succeeds + SSH rejects -> `askpassOk=Some(true)` and
  `authentication_rejected`, not a local credential read failure.
- Probe/deploy exits -> exit code and safe reason even before stderr streaming
  begins; missing status stays `None`, never infer an exit code from a timeout.
- Missing artifact, upload/install failure or handshake mismatch -> failed stage;
  the existing single forced-redeploy retry retains the same attempt ID.

### 5. Good / Base / Bad Cases

Good: locate a failed `platform_probe` and distinguish credential access, network,
SSH negotiation and authentication rejection. Base: successful startup logs only
bounded lifecycle metadata. Bad: persist raw stderr or infer that a timeout proves
bad credentials.

### 6. Coverage When Requested

Pending authorization: check successful/rejected/missing-credential SSH login,
askpass launch failure, refused/unresolvable hosts, missing artifacts, reuse versus
upload, protocol retry, interruption and concurrent attempts. Assert diagnostics
never include secret payloads, stdout remains password-only, returned errors omit
askpass markers, and non-diagnostic SSH workspace/tunnel callers remain unchanged.
Windows askpass/desktop behavior still requires Windows runtime verification.

### 7. Wrong vs Correct

Wrong: only log `connect begin` and replace the failure with a generic toast.
Correct: record each startup boundary and safe failure metadata in the shared Host
runtime without changing authentication or frontend behavior.

## Shared Request Failures and Session Watchers

### 1. Scope / Trigger

Shared `ServerClient`/`ServerManager` requests, Remote HTTP outcomes and session
watcher background work. This is not a blanket wrapper for all Tauri commands.

### 2. Signatures

- `request_failure_reason(method, error) -> Option<&'static str>` returns only
  fixed labels; `None` identifies explicitly expected outcomes.
- `api_error` keeps its status/JSON body and attaches an internal
  `ApiFailureDiagnostic` response extension; no raw error enters this metadata.
- HTTP `log_request_failure` runs outside the existing 45-second timeout layer.
- `WatchEvents` owns per-watcher error/emission summary limits;
  `RepeatedFailureLog::failure/recover` tracks skipped records, not retry policy.

### 3. Contracts

- Shared service failures include method, elapsed time and safe reason. Wire
  failures correlate native `requestId` with `launcherPid`; setup/decoding errors
  use connection ID and phase instead because no matching wire reply may exist.
  Existing startup records map launcher PID to connection/attempt ID.
- Cover already-closed clients, enqueue/response failures, connection setup/retry
  failures and malformed responses. Keep existing timeout metadata without a
  second generic warning for the same local timeout. `session.watch_start`
  failures belong to the watcher summary rather than a warning on every retry.
- HTTP failures have a process-local `httpRequestId`, host PID, known HTTP verb,
  declared `MatchedPath` template, status, elapsed time and safe reason. Unknown
  verbs/routes use `OTHER`/`unmatched`; never log URI/query, request/response body,
  headers, pairing request proof, tokens or raw exception text. HTTP IDs and RPC
  envelope IDs are separate namespaces, not end-to-end distributed tracing.
- HTTP 5xx/408 are warnings. Custom 400 responses retain diagnostics: classified
  backend failures warn, unclassified/invalid requests use Info. Ordinary
  authentication rejection, 404, conflicts, rate limits and extractor validation
  failures do not create new failure records. Explicit cancellation/stale-history
  outcomes stay quiet even if an existing handler maps them to an error status.
- Watcher logs correlate projects using `projectHash` (SHA-256 of the project ID).
  Project IDs and their derived stream IDs embed workspace paths: never log them
  raw in these summaries. Event payloads retain the original IDs.
- Watcher logs include start/stop, disconnect, first failed reconnect, periodic
  failure summaries and recovery with attempts/elapsed time/suppressed counts.
  Reconnect, backend/index error and event-emission summaries use separate limits:
  first failure immediately, then at most one per 60 seconds while failing.
  Disconnect/recovery are transitions, not throttled periodic warnings.
- Failed event emission logs only project hash, event kind and fixed reason. A
  subsequent successful emit records recovery; success does not prove a window
  has subscribed or processed the event. Event payloads and indexing fallback
  behavior remain unchanged. Limits apply to these new watcher summaries, not
  existing connection-attempt/server-stderr diagnostics.

### 4. Validation & Error Matrix

- Exact startup cancellation, history-changed and history-shutdown strings -> no
  new failure warning; normal cleanup on a stopped/disconnected client stays quiet.
- `fs.stat` ending with OS missing-file/path code 2/3 -> expected absence;
  permission errors still warn. Do not suppress every method's missing-file error.
  Match `Permission denied (os error ...)` as `filesystem_permission_denied`
  before the broader SSH `Permission denied (...)` authentication rule.
- Watcher reconnect -> retain 250 ms initial delay, doubling up to 10 seconds.
  Logging suppression never skips an attempt or alters the current-client update.
- Explicit watcher stop aborts its task normally; it is not a reconnection failure.

### 5. Good / Base / Bad Cases

Good: identify the failing service method or HTTP route and see a watcher recover
after multiple attempts. Base: successful high-frequency requests/events add no
new per-message logs. Bad: log full URLs/errors or emit one new warning per retry.

### 6. Coverage When Requested

Unit tests in `runtime/connection_diagnostics.rs` cover expected cancellation,
method-scoped missing-file/cleanup suppression, filesystem versus SSH permission
errors, credential-read failure versus SSH rejection, and fixed unknown labels.
`runtime/session_watcher.rs` tests first-failure logging, suppressed counts, the
60-second summary and one-shot recovery/reset by adjusting the internal timestamp
without sleeping. These tests pass in the WSL workspace test run.

Pending authorization: cover closed/enqueue/RPC/setup/decode failures, HTTP
400/401/404/408/5xx and timeout-layer ordering. Assert URL/query/header/body secrets
and raw watcher project/stream IDs never enter new logs, responses/events remain
unchanged, and cancellation still stops retries. Runtime verification must cover
Desktop and WebUI separately.

### 7. Wrong vs Correct

Wrong: add raw `console.error` calls to every UI catch or log every changed path.
Correct: log safe metadata once per relevant Host boundary and aggregate recurring
background failures without changing control flow or public error handling.
