# Remote WebUI & Event Hub

> Executable contracts for the Remote WebUI adapter, its auth model, and the
> multi-subscriber runtime event bus.

---

## 1. Scope / Trigger

Apply code-spec depth when a change touches:

- The HTTP/WebSocket Remote adapter and desktop LAN discovery (`runtime/remote/*`).
- The `RuntimeEventBus` broadcast/replay contract (`runtime/events.rs`).
- `remote_host_config` / `remote_pairing` / `remote_devices` SQLite tables.
- The transport-neutral `PiloClient` boundary (`src/lib/api/pilo-client.ts` + adapters).

The Remote adapter is a **transport adapter into the same Host** — it must not own
session state, and it must not call Tauri-specific types from Application code.

---

## 2. Signatures

### Tauri commands (desktop transport)

Parsed in `runtime/commands/remote.rs`; registered in `lib.rs`:

```rust
remote_host_state()                       -> RemoteHostState
remote_lan_addresses()                    -> string[] // host IPv4 literals, no port
remote_set_enabled(enabled: bool)         -> RemoteHostState
remote_set_port(port: u16)                -> RemoteHostState
remote_set_public_base_url(publicBaseUrl: String) -> RemoteHostState // compatibility
remote_set_addresses(addresses: Vec<RemoteAccessAddress>, entryAddressId: String) -> RemoteHostState
remote_pairing_regenerate()               -> RemoteHostState
remote_device_revoke(deviceId: String)    -> RemoteHostState
remote_device_rename(deviceId: String, name: String) -> RemoteHostState
```

`RemoteAccessAddress` (`camelCase`): `{ id: string, name: string, baseUrl: string }`.
`name` may be empty. `RemoteAccessConfig`: `{ addresses, entryAddressId }`.

`RemoteHostState` (`camelCase`): `enabled`, `running`, `port`, `baseUrl?`,
`publicBaseUrl`, `addresses[]`, `entryAddressId`, `addressConfigError?`,
`pairingUrl?`, `pairingExpiresAtMs?`, `pairingRemainingUses`, `pairingTotalUses`,
`lastError?`, `devices[]`. Desktop alone receives the active pairing URL.

### Desktop runtime subscriptions (`runtime/commands/runtime.rs`)

- `runtime_subscribe_events(window: WebviewWindow, events: State<RuntimeEventBus>, channel)`:
  Tauri injects the calling window; the frontend still sends only `{ channel }`.
- `RuntimeEventBus::subscribe(window_label, channel)` replaces that window's
  subscription, not other windows. `unsubscribe(window_label)` runs on
  `WindowEvent::Destroyed`, not a cancellable close request.

### HTTP routes (`runtime/remote/api/mod.rs`)

Public:

```text
GET  /api/v1/health          -> { ok, service }
POST /api/v1/auth/pairing    -> { addresses: [{ id, name, baseUrl, issued }], expiresAtMs, remainingUses }
                              body: { secret }
POST /api/v1/auth/pair       -> { token, device }
                              body: { secret, addressId, requestId, deviceName? }
```

Authenticated (`require_auth` middleware):

```text
GET  /api/v1/bootstrap       -> { projects, chatSessions, latestSequence }
GET  /api/v1/theme           -> ThemeSettings (Host SQLite)
POST /api/v1/theme           -> ThemeSettingsUpdate body -> committed ThemeSettings
GET  /api/v1/sessions?projectId=...&cached=true // optional; default reconciles JSONL
GET  /api/v1/history?projectId=&sessionPath=&startMessage=&messageLimit=&includeMessageIndex=
GET  /api/v1/models?projectId=... -> ProjectModelCache | null  (Host-cached model and command catalog)
POST /api/v1/models          -> ProjectModelCache        body: ProjectModelCache (Host assigns timestamp)
POST /api/v1/chat/start      -> PiSessionSnapshot        body: ChatStartRequest
GET  /api/v1/chat/state?sessionKey=...
POST /api/v1/chat/rpc        -> 204                      body: { sessionKey, command }
GET  /api/v1/files/search?projectId=&query= -> string[]  (read-only @ mention search)
GET  /api/v1/files/image?projectId=&path= -> binary image bytes (project-relative, image-only)
POST /api/v1/chat/files?projectId=&name= -> JSON server-side absolute path (raw file bytes, max 10 MB)
GET  /api/v1/events          -> WebSocket upgrade
```

`fallback` serves the embedded Mobile WebUI from the Tauri asset resolver.

### WebSocket protocol

- Subprotocols: `pilo`, `pilo-token.<token>`.
- Client may pass `?after=<sequence>` for replay.
- Server frames: `{ type: "hello", deviceId, latestSequence }`,
  `{ type: "events", events: SequencedRuntimeEvent[] }`,
  `{ type: "resyncRequired", latestSequence }`.
- Transport-only heartbeat: client `{ type: "ping" }`, server `{ type: "pong" }`.
  The Web adapter consumes pong; it is not a sequenced runtime event or a resync.
- `SequencedRuntimeEvent` = `{ sequence, ...RuntimeEventEnvelope }` (flattened).
- Background index events are global, without Pi generation/session keys:
  `sessions_indexed { projectId }` once after the background worker finishes and
  `session_index_error { projectId, message }` on worker failure. They bypass
  conversation reducers; indexed notifications read `cached=true`, not rescan.
- Token is read from `Authorization: Bearer` **or** the `pilo-token.` subprotocol
  — never from the URL query.

### Storage (`runtime/storage/remote.rs`)

```text
remote_host_config(id=1, enabled, port, public_base_url, addresses_json NULL, entry_address_id)
remote_pairing(id=1, secret_hash, expires_at_ms, consumed_at_ms)
remote_devices(id, name, pair_ip, token_hash, created_at_ms, last_seen_at_ms, expires_at_ms, revoked_at_ms)
```

---

## 3. Contracts

- **Secrets**: pairing secret and device token are 32 random bytes, URL-safe
  base64. Only SHA-256 hashes are persisted. Plaintext never reaches the DB or logs.
- **Address configuration**: 1–32 distinct normalized HTTP(S) origins, root
  URLs only; reject credentials, query, fragment and subpath mounts. IDs are
  unique ASCII alphanumeric/hyphen strings (1–80 bytes); optional names are
  trimmed and bounded to 80 characters. Entry ID must exist in the list.
  Guarded additive columns keep `RemoteHostConfig` / `RemoteDevice` unchanged.
  `addresses_json IS NULL` projects runtime LAN plus the legacy public address,
  deduplicates origins and defaults entry to LAN. Once saved, the explicit list
  is authoritative. Invalid legacy URLs remain editable with an error but are
  excluded from pairing targets. Editing targets invalidates the old batch and
  generates a new one without clearing devices. The desktop pins the entry to the
  `lan` address when one exists and no longer exposes entry or name editing;
  legacy `name` values stay in storage but are neither edited nor shown. The
  legacy command edits only the `public` entry.
  The saved-address editor and WebUI pairing choices share
  `sortRemoteAddresses` from `src/lib/remote-addresses.ts`: RFC1918 IPv4 origins
  appear before public/custom origins, preserving order within each group.
  This is display ordering, not default-entry selection or a persistence migration.
  Sort saved editor rows, not the live draft, so typing does not move the focused
  row. Compare `sortRemoteAddresses(config.addresses)` against the sorted saved
  projection, not an unsorted draft against a sorted list. Enter can preserve
  `[public, LAN, empty]` after a save; unchanged blur must not write again just
  because the saved display projection is `[LAN, public]`.
- **Remote settings surface**: the desktop-only dialog in `sidebar-footer.tsx`
  uses the shared Radix `ScrollArea`, not an `overflow-y-auto` dialog. Keep the
  heading/close control outside the scroll viewport and use a `minmax(0, 1fr)`
  content row, `min-h-0`, and `overscroll-contain`. Reuse theme scrollbar tokens;
  do not add a Host-management dialog or native APIs to WebUI.
- **LAN discovery**: desktop-only, on picker open, never part of the 3-second
  state poll or an HTTP route. `remote/lan.rs` reads Up interfaces through Windows
  PowerShell/.NET, macOS `ifconfig -u`, or Linux `ip -o -4 addr show up`, with a
  5-second timeout and child cleanup. Return deduplicated IPv4 literals, preferring
  Windows physical adapters identified by `Get-NetAdapter -Physical`, then RFC1918
  addresses, then numeric IP order. If adapter classification is unavailable,
  retain all candidates and fall back to RFC1918-first sorting; other platforms
  also use this fallback. Keep virtual/VPN addresses selectable. Exclude loopback,
  unspecified, link-local, multicast and broadcast.
  The listener is IPv4-only. The address-header icon picker combines each IP with
  the saved listener port, disables already-configured origins, and reuses the existing
  draft/save flow (including empty rows and the 32-address limit). Disable picks
  during address saves; preserve drafts and report save failures normally. Do not
  probe reachability or silently add every interface. WebUI pairing stays unchanged.
  Quick-added entries use `lan-<IPv4 with dots replaced by hyphens>-<32 hex UUID>`
  IDs, including when filling an empty row. The IP records the original direct
  host; the UUID prevents ID collisions if an older entry was manually edited.
- **Port edits**: `remote_set_port` follows a saved `lan` entry only when its
  URL exactly matches the previous runtime LAN URL (or the current LAN IP with
  the old port while stopped). It also updates every quick-added LAN entry whose
  URL still equals `http://<IP encoded in ID>:<old listener port>`. Manually changed
  hosts, schemes or ports do not follow. Unmarked custom/proxy entries stay unchanged.
  Validate the resulting list before stopping; a duplicate origin rejects the
  change. Persist the port, updated LAN URL and the existing device-clearing
  policy in one transaction, then restart so links use the new targets.
- **Pairing TTL / quota**: 10 minutes absolute with a fixed address snapshot and
  one slot per origin. `PairingSession` in `remote/pairing.rs` owns serialized
  exchange and in-memory receipts; `remote/access.rs` owns URL normalization.
  POSTing `/auth/pairing` only validates the secret and consumes nothing.
  Multi-address `/pair` waits for explicit selection; single-address `/pair`
  automatically exchanges for that origin before opening the workspace.
  Neither flow mounts chat connection hooks before authorization.
  No per-device automatic rotation. Exhaustion sets `consumed_at_ms` and hides
  the desktop QR; descriptions and original-proof retries remain available
  within the original TTL, but no new authorization can be issued.
- **Atomic / idempotent exchange**: `requestId` is a 32-byte CSPRNG proof encoded
  as 64 hex characters, stored in target-origin `sessionStorage` before POST.
  Never use `utils.randomId` / its `Math.random` fallback for this proof.
  The batch mutex covers an immediate SQLite transaction, device insertion,
  exhaustion update and receipt recording, all inside `spawn_blocking` with no
  await between commit and receipt. TTL is checked after acquiring the SQLite
  transaction lock, not against an earlier device creation timestamp. Failures
  roll back without losing slots. Matching secret/address/proof returns the
  same original token only while the device is valid; another proof gets 409.
  Retries do not create records or extend device expiry.
- **Pairing invalidation / ownership**: restart, stop and manual regeneration
  discard receipts and plaintext secrets, never valid device tokens. Receipts
  are bounded by address count, process-local and never Debug/logged/persisted.
  Every operation enforces TTL; a listener-owned 15 s tick also clears expired
  idle receipts. Manager serializes configuration/regeneration using its Tokio
  mutex while awaiting blocking work; HTTP only takes the batch mutex, never
  the manager mutex. Snapshot clones running references before blocking work.
- **Browser pairing lifecycle**: new links use `/pair#pair=<secret>`; selection
  links use `/pair/complete#pair=<secret>&address=<id>&entry=<entryId>`. A single
  parser accepts fragment and legacy query links, saves temporary context to
  sessionStorage and immediately replaces the URL with a clean pairing path.
  Expiry, request proof and entry ID are temporary, never stored in localStorage.
  Target pages validate origin against server metadata, reuse a valid local token
  or explicitly exchange, then save the token origin-locally. With exactly one
  configured address, selection is automatic and successful authorization replaces
  the page with `/`, without selection/completion UI. Keep origin validation,
  persisted retry proof and error/retry UI; never bypass authentication. Ordinary links
  `/` and return links `/pair` have no credentials. The same-tab selection page
  resumes from its own origin storage; closing the tab need not resume pairing.
  Foreground/retry revalidates; expiry/401 clears temporary context. `issued`
  means server issuance, not proof another origin persisted the token.
  Do not introduce popup batches, cross-origin fetch/iframes or arbitrary
  fragment return URLs. Fragment is not a substitute for HTTPS.
- **Pairing cache boundary**: both auth POST routes apply `Cache-Control:
  no-store`, including rate-limit and JSON rejection responses. No pairing
  response, full pairing URL or token may enter the PWA cache.
- **Device token TTL**: 30 days absolute. Revoked or expired tokens fail auth
  immediately; live WebSockets re-check every 15 s and on `auth_generation` change.
  Each newly paired origin gets an independent device record/token, individually
  revocable but not strictly origin-bound. Existing valid tokens survive address
  migration and restart; the pre-existing port-change clearing policy is separate.
- **Device identity**: `deviceName` is an optional, client-supplied label. The
  Remote WebUI sends `describeDevice(navigator.userAgent)`
  (`src/lib/device-name.ts`) — `机型/系统 · 浏览器` — because a raw UA is
  unreadable in the device list. New labels append the pairing address name/URL,
  using bounded portions (40 device-name + 36 address characters). `pair_ip` is the pairing request's peer IP from
  `ConnectInfo<SocketAddr>`, not client-supplied.
- **Device rename**: `remote_device_rename` reuses `auth::normalize_device_name`,
  so the same 80-char bound applies. Renaming requires the device to exist and
  not be revoked.
- **Auth scope**: authenticated == full MVP capability. No roles/capabilities yet.
- **Auth rate limiting**: only the pairing secret is IP-rate-limited (5 failures /
  60 s). Device tokens are 32 random bytes looked up by SHA-256 hash, so they are
  **not** rate-limited — blocking them turned the `401` a client needs to drop a
  stale token into an unrecoverable `429` lockout (and also gated `/auth/pair`).
- **Stale auth responses**: HTTP JSON/image helpers clear localStorage on 401
  only if its token still equals the token sent by that request. Pairing pages
  do not clear it again; the workspace error handler adopts the current stored
  token instead of discarding a newer authorization. Effect cancellation alone
  cannot prevent a late response from deleting credentials.
- **RPC allowlist**: only chat-mutating/querying commands are forwarded (see
  `ALLOWED` in `api.rs`). No generic command proxy; Terminal/Files/Git are not exposed.
- **Files surfaces**: `GET /api/v1/files/search` forwards host `fs.search` and
  returns paths only. `/files/image` is the image-only exception for Markdown
  replies (see below); generic reads, writes, and directory listing stay private.
- **Model and command catalog**: `GET /api/v1/models` returns the shared
  `project_model_cache` snapshot (or `null`). Complete caches have no TTL or
  periodic refresh. On missing/incomplete caches or explicit refresh, WebUI
  reuses the same TypeScript probe logic as Desktop through the existing socket
  and chat transport, then persists via authenticated `POST /api/v1/models`.
  `builtinExtensions: [{ id: "model-catalog" }]` on `/chat/start` is allowed only
  with `noSession: true` and no sessionPath; other client-selected extensions
  are rejected. This path calls `chat_service::prepare`, not `start`, to avoid
  creating an empty persisted session. Normal chats retain their existing path.
  See [Project Model Scope](./project-model-scope.md#project-catalog-and-slash-commands).
- **Attachments**: images (`png/jpeg/webp/gif`) reuse the inline chat image contract,
  ≤ 10 MB each, ≤ 20 MB total, ≤ `MAX_CHAT_IMAGES`. Other files use the scoped
  server-runtime upload/cleanup described in "External Files in the Composer".
- **Envelope timestamp**: `RuntimeEventEnvelope` carries an optional `timestampMs`
  (epoch ms). `RuntimeEventBus::send` stamps it once, before the event enters both
  the live queue and the replay buffer, for `assistant_thinking_start/delta/end`;
  a value already set by the producer is preserved. Clients therefore read the
  same value live and after reconnect replay, so a duration derived from it never
  mixes the Host clock with client processing time. Other event kinds stay
  unstamped: an absent timestamp means "unknown", never "now".
- **Replay gap semantics**: `replay_after(seq)` returns `None` (gap → client must
  resync from snapshot) **iff** the oldest buffered sequence is greater than
  `seq + 1`. `seq == 0` always replays the whole buffer.
- **WebSocket auth expiry**: the upgrade is rejected with a plain `401` before
  the handshake, which browsers surface as an opaque `1006` close — identical to
  a network drop. `event_socket` also closes the socket when `auth_tick` (15 s)
  finds the token revoked/expired. The signal is therefore **lossy on the socket
  path**: `remote-app.tsx` re-probes `bootstrap` on every socket disconnect so the
  `401 → REMOTE_AUTH_EXPIRED → clear token → pairing screen` chain still runs.
- **Desktop windows**: keep one Tauri channel per window label. Broadcast each
  runtime event (including completion and RPC replies) to every registered window.
  Reload replaces only the caller's channel; destroying a window removes only its
  subscription. Send outside the registry lock; failure for one window must not
  prevent delivery to others. Desktop RPC IDs use `pilo-<randomId()>`, not a
  timestamp plus a window-local counter: concurrent windows sharing a session
  must not resolve each other's pending requests. Preserve the `pilo-` prefix
  used for caller-correlated error handling. Web broadcast/replay remains independent.
- **Backpressure**: Web subscribers share a 512-event / 64 MiB serialized-payload
  ring, with independent sequence cursors and payload-free watch notifications.
  A lagging subscriber receives `Lagged` and is told to `resyncRequired` instead
  of blocking the runtime. Events exceeding the live byte limit also create a
  gap. Desktop Tauri channels remain independent and unaffected. See
  [Runtime Resource Lifecycle](./runtime-lifecycle.md) for replay/stream limits.
- **Browser recovery**: Remote Browser owns `online/offline` and foreground
  lifecycle recovery. `navigator.onLine` is advisory only: an already-live
  WebSocket remains authoritative, while an offline hint may slow background
  polling/retry but must not hard-disable LAN HTTP/WS access. Returning online
  recreates the WebSocket. Returning from at least 1.5 seconds in the background
  instead probes an open socket with an application-level ping (browser APIs
  cannot send native Ping frames). Any received server frame clears the 5-second
  deadline; failure/timeout closes the socket and uses ordinary reconnect. Clear
  the deadline on hide, disconnect and disposal. Healthy foreground return must
  not emit disconnected, hello or snapshot-refresh transitions: these discard
  pending/completed input assistance even when the Session has not changed.
  Ordinary reconnects consume sequence replay and refresh bootstrap/session
  metadata; only an explicit `resyncRequired` frame may trigger full history
  resync.
- **Cached session-list recovery**: `cached=true` reads the Host SQLite index
  through `session_list`, without requiring a live server. WebUI loads it before
  normal reconciliation and retains it on scan failure. Normal requests reuse
  `session_reconcile`, including deferred background indexing. Initial imports
  synchronously summarize the latest 10 files; ordinary refreshes use the same
  10-summary budget so fork/rename flows can immediately observe new metadata.
  Remaining files are indexed in background batches of 64, with one desktop/WebUI
  notification after the worker finishes, not after each batch, to avoid repeated
  sidebar reordering. Cached event reads wait for queued reconciles to settle;
  WebUI discards superseded event reads and disposed effects. Foreground cache
  reads and scan attempts advance a shared per-project session revision; removing
  an indexed session advances it too. Every list response checks its captured
  revision before replacing that project's rows, so a late response cannot undo
  a newer refresh or deletion. Background reads capture the revision after waiting.
  Refreshes for one project are serialized and overlapping requests queue a rerun,
  even when the current scan fails. Authentication expiry stops the queue;
  otherwise report a scan failure only when no rerun is pending. Per-project
  refresh errors stay visible independently of successful bootstrap responses;
  success clears only that project's error. Server capability mismatches remain
  fatal: rebuild the matching dev runtime in the checkout running Pilo and restart,
  or update the release bundle; never remove required capabilities as a workaround.
- **Remote session-list refresh**: stable project IDs prevent activity-only
  bootstrap updates from restarting every project scan or external-activity
  poll. `scheduleRuntimeActivityRefresh(projectId?: string)` batches affected
  project IDs for 120 ms and refreshes their session indexes alongside bootstrap.
  Creation, completion, compaction, process-state and `set_session_name` response
  events supply their project ID before filtering for the visible session;
  activity-only events refresh bootstrap without scanning all projects. Verify
  that a desktop-created background chat appears in WebUI without manual refresh.
- **PWA cache boundary**: the Service Worker is progressive enhancement for
  production Remote Browser on a secure context only. Tauri never registers it.
  It may precache the minimal built App Shell, but `/api/v1/**` is always
  network-only and navigation fallback always uses the canonical cached
  `index.html` (never the requested pairing URL). Web updates require explicit
  user activation rather than automatically reloading an active chat. A newly
  activated worker does not claim existing tabs; stale version caches are removed
  only after every open window in scope is controlled by the current worker.

---

## 4. Validation & Error Matrix

| Condition                                   | Result                                          |
| ------------------------------------------- | ----------------------------------------------- |
| Missing/invalid Bearer or `pilo-token`      | `401 authentication required`                   |
| Unknown/expired/revoked token               | `401 invalid or expired device token`           |
| Invalid or expired pairing secret           | `401 invalid or expired pairing link`           |
| Unknown pairing address / malformed proof   | `400` (missing old-client fields fail explicitly) |
| Slot claimed with a different request proof | `409 pairing address already used`              |
| Original receipt's device revoked/expired   | `401`; receipt cannot restore authorization     |
| SQLite insert/commit fails                  | `500`; no receipt or quota consumed             |
| LAN discovery timeout / process failure      | picker error with retry; keep configured addresses |
| LAN discovery returns no usable IPv4         | picker empty state; manual entry remains available |
| Invalid access config / duplicate origin    | desktop command error; keep draft for correction |
| Too many pairing failures from one IP       | `429 too many authentication attempts`          |
| Device token revoked while WS open          | socket closed; client must re-probe for `401`   |
| RPC `type` not in allowlist                 | `400 chat command '<type>' is not available…`   |
| Non-image attachment / wrong mime / too big | `400 …` (see `validate_remote_images`)          |
| Unknown project/session                     | `404`                                           |
| Session scan fails (including stale server)  | `500`; WebUI retains the Host index and displays the error |
| Handler `Result::Err(String)`               | `400` for chat start/rpc, `500` for internal    |
| Request body over `MAX_REQUEST_BYTES`       | rejected by `DefaultBodyLimit`                  |
| Handler over 45 s                           | `408` (Tower timeout)                           |
| WS buffer lag                               | `resyncRequired`, connection kept               |
| Healthy foreground socket probe             | Pong consumed locally; no reconnect or prediction invalidation |
| Foreground probe timeout/send failure        | Socket closes; existing auth probe/reconnect/replay runs |
| Another desktop window subscribes/reloads   | Existing windows retain completion/RPC delivery |
| Desktop window destroyed                   | Remove only that window's channel               |

---

## 5. Good / Base / Bad Cases

- **Good LAN picker**: multiple host IPv4s appear with the saved port; selecting
  one saves only that origin, while existing origins are marked Added. No suitable
  interface leaves manual entry unchanged; discovery failure offers retry.
- **Good desktop**: main and session windows both receive completion; reloading
  or closing the session window does not strand the main window in processing.
- **Good**: Desktop + two Web clients observe the same session; each subscriber
  gets ordered identical sequences; a brief disconnect replays from `after`.
- **Good pairing**: scan once → selection (zero consumption) → manually open
  three origins → three independent tokens; plain bookmarks subsequently work.
  Lost response + the original proof returns exactly the original authorization.
- **Good foreground**: hide a WebUI with a pending/completed suggestion for more
  than 1.5 seconds, return with its socket intact, and retain the suggestion
  without a new prediction call. A stale socket still reconnects after probe failure.
- **Good session recovery**: reloading WebUI with an unavailable/stale server
  still displays previously indexed sessions and reports the scan error.
- **Base**: Remote disabled → no listener, no port, Desktop path unchanged.
- **Bad pairing**: an unreachable target is not authenticated. Retry before TTL
  or obtain a fresh scan after expiry. Another proof cannot retrieve an issued
  token; regeneration/restart rejects all previous-batch requests, while valid
  device tokens remain usable.
- **Bad**: A Web client that stops reading must **not** stall Pi streaming; it is
  dropped to `resyncRequired` after its cursor falls behind the live ring.

---

## 6. Tests Required

Session recovery assertions, pending explicit authorization (no tests added or
run): cached reads do not contact the server; unknown projects remain 404;
scan failures retain cached sessions; bootstrap success cannot clear scan errors;
successful retry clears only its project's error; overlapping refreshes rerun
serially after either success or failure, but stop on authentication expiry;
late background-cache and foreground-scan responses cannot overwrite a newer
refresh or restore a removed session; initial import returns the latest 10
summaries and defers the rest.
Verify one desktop/WebSocket update after background work finishes (no per-batch
sidebar reordering), cached-only notification reads, visible background errors,
and a late reconcile response not overwriting the completed index. Fork navigation must still observe
its new indexed session before switching.

Foreground recovery assertions, pending explicit authorization (not run): healthy
socket ping/pong or intervening events preserves input assistance; silent socket
closes after 5 seconds; repeated hide/resume and disposal leave no probe timers or
visibility listeners; real reconnect still invalidates predictions and replays
without creating a new model call; auth expiry still reaches pairing.

LAN picker assertions, pending explicit authorization (no tests added or run):
multiple/duplicate interfaces, excluded IP classes, timeout/failed command, empty
result, already-added origins (including default ports/trailing slash), empty-row
reuse, save overlap/failure, 32-origin cap, Windows PowerShell enumeration and
narrow-screen keyboard/touch menu behavior. Saved-editor and pairing-list order
must put RFC1918 hosts above public/custom origins regardless of address IDs,
retain same-group order, keep live draft rows fixed, and avoid writes on unchanged
blur. No tests were added or run for saved-list sorting.

Assertion points (inline `#[cfg(test)] mod tests`):

Existing assertions (not changed for multi-address pairing):

- `storage/remote.rs`: legacy config round-trip; test-only one-time consume helper
  expires; authenticate rejects revoked and expired devices; `pair_ip` round-trips
  and `rename_remote_device` updates only existing, non-revoked devices.
- `remote/auth.rs`: hashes are 64-char hex and never equal the plaintext;
  device names are bounded to 81 chars with `…`.
- `remote/api.rs`: `validate_remote_rpc` rejects `terminal_write`/`fs_read_file`
  and non-image attachments; `token_from_headers` reads `pilo-token.` from the
  subprotocol.
- `runtime/events.rs`: web subscribers share one ordered stream with matching
  sequences; `replay_after` reports a gap only after the buffer has evicted
  `seq + 1`; replay slice after eviction returns exactly the latest event.

---

Desktop multi-window assertion points, pending explicit test authorization:

- Two window labels both receive the same runtime event; resubscribing one label
  replaces only its old channel. Unsubscribing one label preserves the other.
- A failed desktop send does not skip another desktop or Web subscriber.
- Concurrent same-session desktop RPCs use distinct IDs even with identical
  timestamps/counters; a reply resolves only its own pending request.
- Windows manual regression: open a session window during a reply, finish/stop
  from each window, reload/close the extra window, and confirm completion plus
  correlated RPC replies still reach the main window. No tests were added or run
  for this fix; source review alone does not establish native delivery behavior.

Additional multi-address assertion points, pending explicit test authorization
(no new tests added or run during this implementation):

- Config NULL migration, explicit list persistence, duplicate-origin rejection,
  invalid legacy URL correction and address edits retaining the batch TTL.
- Saved default and multiple quick-added LAN entries follow repeated listener
  port edits, including stopped/restarted hosts and entries filling empty rows.
  Manually edited hosts/schemes/ports and unmarked custom/proxy URLs stay unchanged;
  quick-adding an IP again after editing its old entry retains unique IDs.
  Duplicate target rejection precedes stop; port/address writes roll
  back together on failure. Device clearing on port edits remains unchanged.
- Late 401 from an old token after successful pairing preserves the new token
  for JSON and image requests and through workspace error handling.
- Concurrent same-proof exchange returns one device; different proofs cannot
  retrieve its token; DB failures roll back; TTL checked after DB lock waits.
- Last slot blocks new issuance but allows original-proof retries until expiry;
  revoke/regenerate/stop/restart cannot restore old receipt authorization.
- Multi-address `/pair` makes no exchange or chat connection; single-address scans
  automatically authorize then open `/`, including reuse of a valid local token.
  StrictMode retries use one proof,
  blocked storage fails before issuance, URLs/return/bookmarks contain no token.
- Windows desktop and actual mobile browsers: single QR entry,
  cross-origin same-tab return, offline recovery, HTTPS→HTTP top-level navigation.

---

## 7. Wrong vs Correct

Session recovery: wrong — block cached session access on a successful remote scan
or swallow scan errors into console-only output. Correct — read the Host index
first, reconcile separately, and keep the refresh error visible until retry or
dismissal. Cached rows do not imply a working server connection.

#### Wrong

```rust
// Gap detection off-by-one: seq 1 with buffer starting at 2 is still contiguous.
if replay.front().is_some_and(|first| first.sequence > sequence) {
    return None;
}
// Tests that send only CAPACITY + 1 events never create a real gap.
```

#### Correct

```rust
if sequence > 0
    && replay
        .front()
        .is_some_and(|first| first.sequence > sequence.saturating_add(1))
{
    return None;
}
// Evict at least two events (CAPACITY + 2 sends) before asserting a gap for seq 1.
```

```rust
// Tauri commands expose their arguments flat; many-arg commands are expected.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // flat IPC argument surface
pub async fn chat_session_start(/* … 8 params … */) { … }
```

---

LAN discovery: wrong — enumerate interfaces in every `remote_host_state` poll
or advertise IPv6 against the IPv4 listener. Correct — enumerate on picker open
through `remote_lan_addresses`, then save one selected IPv4 origin through
`remote_set_addresses`.

#### Wrong: consuming before persisting a device

```rust
consume_remote_pairing(&mut db, hash, now)?;
insert_remote_device(&db, &device, token_hash)?; // failure loses authorization
```

#### Correct: atomic issuance and proof-gated receipts

```text
batch mutex → immediate transaction → validate hash/TTL/unconsumed
→ insert device + mark exhausted if last slot → commit
→ record original token + request proof hash before any await
retry → verify original proof AND unrevoked/unexpired device → same response
```

Do not return a receipt based on only the reusable secret + address ID.

---

## Design Decisions

- **No daemon / no new crate (Phase 1).** Axum + Tower-HTTP live inside
  `src-tauri`; Application logic is `runtime/chat_service.rs`, not a God service.
- **Manager owns the listener.** `RemoteServerManager` is the single place that
  starts/stops the listener, persists `enabled`, and restores on app start.
  Remote OFF means the listener does not exist.
- **EventHub over EventBus.** `RuntimeEventBus` keeps Tauri `Channel` subscribers
  keyed by window label, plus a byte-bounded Web live ring, cursor receivers,
  watch notifications and replay deque.
  Wrong: a single global `Option<Channel>` lets the newest window steal all
  completion/RPC replies. Correct: replace only the subscribing window's channel
  and fan out to all windows. Replay/sequence live in the adapter layer, never
  in the Pi runtime.
- **Transport-neutral client.** `PiloClient` is implemented by `TauriPiloClient`
  (invoke/channel) and `WebPiloClient` (fetch/WebSocket); only Remote-MVP features
  are migrated — generic Files/Terminal/Git stay Tauri-only. Project image reads
  are shared through `PiloClient.readProjectImage`.

## Read-only Screen Viewing

### 1. Scope / Trigger

Capture the interactive Windows Host desktop, not the browser device or a Local/WSL/SSH connection. The desktop owns authorization; the WebUI only requests and renders frames.

### 2. Signatures

- Desktop IPC: `remote_set_screen_sharing(enabled: bool) -> RemoteHostState`; state includes `screenSharing` and `screenSharingSupported`.
- Storage: `remote_host_config.screen_sharing INTEGER NOT NULL DEFAULT 0`. The migration must not change the existing remote-access configuration.
- Protected WebSocket: `GET /api/v1/screen?display=<opaque-id>`; omit `display` for the primary monitor. Use the same device-token subprotocol as `/api/v1/events` on a separate socket.

### 3. Contracts

The first text message is `{ displays: [{ id, primary }], selectedId }`; subsequent binary messages are individual JPEG frames. The browser sends `ack` after decoding a frame. Keep at most one outstanding frame and one latest replacement; time out a stalled consumer. Only the requested monitor is captured. Derive the opaque ID from the active Windows monitor interfaces, not the reassignable GDI source name. Do not advertise displays without a verifiable identity. Switching reconnects the current viewer without changing other viewers; wait up to two seconds for a capture slot to allow the old capture to finish stopping. Closing or hiding the preview releases its capture and the in-memory image. The same route serves LAN WS and tunneled WSS; plaintext LAN does not protect credentials or frames.

Windows capture encodes JPEG at the selected display’s captured pixel dimensions; remove row padding without resampling. The encoded-frame byte cap is independent of resolution (32 MiB); oversized frames are not queued. The WebUI uses a dedicated screen preview, sharing only the pan/zoom hook with chat images. The preview fits the display frame within the available viewport and mobile safe areas, with transparent surrounding space, no visible title or close icon, and a display selector only for multiple monitors. Clicking or tapping the space outside the frame and controls (or pressing Escape) dismisses it without activating the underlying page. Keep the viewer mounted across frame URL changes so that incoming frames do not reset the view.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Missing, expired or revoked credential before upgrade | Existing protected-route `401` |
| Disabled or Host shuts down; unsupported Host; locked or inactive Windows session | Close `4001`, `4002` or `4003`, respectively |
| Selected display unavailable; capture fails; all four capture slots occupied | Close `4004`, `4005` or `4006`, respectively |
| Active viewer authorization expires or is revoked; stream stalls | Close `4007` or `4008`, respectively |
| Shutdown, sharing disablement, session lock or authorization loss interrupts a JPEG write | Drop the transport without flushing the partial frame or sending a close code |

### 5. Good / Base / Bad Cases

- Good: A paired phone opens the primary display without local confirmation; selecting another display changes only that phone's stream.
- Base: Existing installs migrate with viewing off. Single-display Hosts do not show a display selector.
- Bad: If the selected monitor goes away, clear the image and keep the error across tab visibility changes until the viewer makes another explicit selection; never silently choose another monitor.

### 6. Tests Required

Verify a paired phone on both LAN WS and tunneled WSS. On a display larger than 1080p, compare the JPEG’s decoded dimensions with the capture dimensions. Verify that mobile pinch and desktop Ctrl-wheel zoom preserve pan and scale across frame updates, and that changing displays resets the view. Check that clicking or tapping transparent space closes the preview, while interacting with the frame or the display selector does not. With four viewers, switch one display while the other three stay connected. Throttle a frame transfer, then revoke that viewer or disable sharing and verify that the interrupted frame does not finish sending. Verify lock, unplug, toggle-off, backgrounding, and disconnect release capture, and a delayed `ack` never queues older JPEGs. After unplugging a selected display, verify that hiding and reopening the browser tab does not restart capture; replacing a display on the same GDI source must not satisfy the old ID.

### 7. Wrong vs Correct

Wrong: Reuse the chat event socket for images or infer consent from pairing. Correct: Require both current pairing and the desktop opt-in on the dedicated screen socket.

## Project Images in Markdown Replies

### 1. Scope / Trigger

Apply when changing Markdown image rendering, project image transport, or its
security boundary. This uses plain Pi reply text; it does not extend Pi RPC.

### 2. Signatures

- `project_fs_read_image(id: String, path: String) -> Result<Vec<u8>, String>`
- Authenticated `GET /api/v1/files/image?projectId=&path=` -> binary bytes
- `PiloClient.readProjectImage(projectId, path) -> Promise<Uint8Array<ArrayBuffer>>`
- `remote_fs::read_image(servers, project, path)` owns both transport validations.

### 3. Contracts

- `![caption](./screenshots/page.png)` resolves relative to the original project
  in its connection environment, not the browser origin or the Pi session file.
- Frontend decodes URL escaping once and normalizes separators. Backend accepts
  relative paths only; rejects parent components, control characters and URL syntax.
- PNG/JPEG/WebP/GIF only, regular files only, at most 10 MB. Check metadata before
  reading and length/signature afterward. Server canonicalization prevents symlink
  escapes; no generic filesystem API is exposed to WebUI.
- HTTP uses Bearer auth and returns `application/octet-stream`, `no-store`,
  `nosniff`. Tokens must never appear in Markdown, image URLs or query parameters.
- Desktop and WebUI inject project scope into the shared Markdown image component,
  including temporary chats. Project reads deduplicate only in flight by project +
  session + path; new references reread live files instead of reusing completed
  reads. Each resolved Blob has its own entry in the bounded URL LRU, so rereading
  a path does not revoke an earlier reply's URL. History images still reuse URLs
  keyed by session fingerprint.
- Blob images offer Save image. HTTP(S) images offer Open original image (new tab)
  with `target="_blank"` and `rel="noopener noreferrer"`, not `download`: browsers
  ignore that attribute on ordinary cross-origin URLs and otherwise navigate away.
- `MARKDOWN_REHYPE_PLUGINS` keeps raw/sanitize/harden protections. Between sanitize
  and harden, `rehypeProjectImages` preserves non-external `src` in the internal
  `data-pilo-image-src` prop and replaces it with a non-fetchable-by-our-component
  sentinel. The custom image component validates the preserved path. Do not rely
  on harden's rewritten URL: it rebases `./` and silently consumes `../`.
- Images reference live project files, not historical snapshots. No automatic
  prompt injection, screenshot capture, Pi extension or duplicate session store.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Invalid/revoked token | Existing 401 auth handling |
| Unknown project | HTTP 404 |
| Absolute/traversal path, unsupported type, non-regular file, >10 MB, signature mismatch | Command error / HTTP 400, no image bytes returned |
| Missing file / image decode failure | Inline failure with retry |
| No project scope / invalid Markdown source | Unavailable placeholder; never fetch a browser-relative path |

### 5. Good / Base / Bad Cases

- Good: a project screenshot is interleaved with reply text, previewable and savable.
- Base: HTTP(S) images and user/tool image display remain supported.
- Bad: `../private.png`, `/tmp/a.png`, `file://`, data URLs or SVG must not read files.

### 6. Tests Required

- `tests/unit/chat-markdown-images.test.ts`: path decoding/rejection, real Markdown
  plugin order, surrounding text, HTTPS images, in-flight deduplication, rereading
  overwritten files without revoking previous URLs, bounded URL retention, retry
  and history cache regression.
- `remote_fs::tests`: extension/path, matching signatures and post-read size cap.
- Existing server filesystem tests: canonical paths and symlink escape rejection.
- `/tests/browser/chat-markdown-images.html` under Vite: require body
  `data-test-status="passed"`; checks desktop/mobile layout, inline images,
  lightbox/save actions, retry, overwritten screenshots in new replies, external
  action label/target/no-download and no unsafe reader calls. Reader is injected;
  this does not replace Windows desktop and real Local/WSL/SSH end-to-end checks.

### 7. Wrong vs Correct

- Wrong: render a relative `<img src>` directly, infer safety from harden's rebased
  URL, use unauthenticated file URLs, or serve arbitrary project bytes to WebUI.
- Correct: preserve and validate the original source, use the image-only scoped
  host read, and display Blob URLs through the shared preview component.

## External Files in the Composer

### 1. Scope / Trigger

External file drops and attachment picking share `ChatComposer` on desktop and
WebUI. This adds scoped attachment upload/cleanup, not generic Web filesystem
access.

### 2. Signatures

- `project_chat_file_upload(id, name, data: Vec<u8>) -> Result<String, String>`
- Authenticated `POST /api/v1/chat/files?projectId=&name=`: octet-stream body;
  returns a JSON string containing the absolute path in the selected environment.
- `project_chat_file_remove(id, path) -> Result<(), String>` and authenticated
  `DELETE /api/v1/chat/files?projectId=&path=` (204 on success) remove one
  attachment directory, subject to server-side validation.
- Server transport: `chat.file_upload({ id, name }, binary: [bytes]) -> string`
  and `chat.file_remove({ path }) -> null`. The Host generates the canonical
  16-byte base64url ID; only the server resolves its runtime root. Both methods
  are required server capabilities. `MAX_CHAT_FILE_BYTES` lives in `pilo-protocol`.
- Shared `ChatComposer.onUploadFile(file: File) -> Promise<string>` is supplied
  by the desktop files adapter or `WebPiloClient.uploadChatFile`.
- `chat-file-lifecycle.ts` registers an upload's transport-bound cleanup callback,
  discards removed/late uploads and retains submitted references.

### 3. Contracts

- PNG/JPEG/WebP/GIF remain inline Pi image attachments. Other files are copied
  into `<server-runtime>/attachments/<host-generated-random-id>/<name>` in the
  selected project's Local/WSL/SSH environment. The existing `runtime_directory()`
  resolves `PILO_SERVER_RUNTIME_DIR`, or the platform's `pilo[-dev]/server` cache.
  Do not write new uploads into the project or migrate/delete old `.pilo/` files.
- The caller never chooses a destination. Names are trimmed, nonempty, at most
  240 UTF-8 bytes, and reject dot/parent names, separators, control characters,
  Windows-invalid punctuation and trailing dots. The server validates names,
  canonical 16-byte base64url IDs and the 10 MB cap; an `attachments` symlink is
  rejected. Create each random directory exclusively, never overwrite/reuse it.
- Append ordinary quoted absolute file mentions only after successful writes.
  Return paths usable by Pi in that same environment, with Windows forward
  slashes and no verbatim `//?/` prefix. The shared mention parser recognizes
  absolute `attachments/<canonical-id>/<name>` references; unrelated absolute
  session paths stay literal. Existing project-relative mentions remain valid.
  File-only messages work without new Pi RPC fields or a duplicate conversation store.
- One batch is limited to eight files / 20 MB, each at most 10 MB; existing image
  count/total limits still apply. HTTP and shared backend enforce the per-file cap.
- Pending reads/uploads block sending and further attachment additions, not text
  editing. Merge paths into the latest draft. Scope identity changes on session,
  project or disabled-state transitions; late results cannot modify another draft.
  Show preparation with a same-size spinner in the existing attachment button and
  a screen-reader status, not an extra in-flow notice row. Pass `submitBlocked`
  to the input hook rather than toggling `disabled`: upload completion must not
  invoke its disabled-to-enabled autofocus or move the composer before attachment
  contents themselves change.
- Set `dragDropEnabled: false` for the main and session windows: Windows HTML5
  file drops otherwise conflict with Tauri's native handler. Visible composers
  accept drops only inside their closest `[data-chat-panel]` (including new-chat
  landing pages), falling back to the composer itself. Leaving that panel clears
  the hint; sidebars, headers and settings cannot add attachments. Window-level
  handlers still prevent file navigation everywhere and ignore modal/disabled
  targets.
- Failed writes trigger server-side best-effort directory cleanup, preserving the
  original upload error. A directory-creation failure must not delete an existing
  directory. Late successful uploads that cannot enter their original composer
  are cleaned up too.
- Only newly uploaded files are registered for frontend cleanup. Removing their
  file mention through composer edits deletes their generated directory. Cleanup
  accepts only `<this-server-runtime>/attachments/<canonical-id>/<valid-name>`;
  validate the exact server-side root, ID and filename before deleting the one
  generated directory. Reject traversal, alternate roots and nested paths; never
  broaden the project filesystem APIs to permit arbitrary absolute writes/deletes.
- Protect referenced files before invoking any submit/steer/follow-up/send-now
  callback, not after RPC success: async commands, queues and failure recovery may
  already own them. This deliberately retains attempted submissions even if a
  downstream guard/command consumes them without sending a normal prompt.
- Drafts survive project/session switches and composer remounts, so switching or
  unmounting alone must not delete their uploaded files. The in-memory ownership
  registry survives remounts; it does not adopt history/existing filesystem files.
  Folder uploads, crash/restart garbage collection and sweeping old attachments
  are not provided. Submitted files are retained to keep history/retries usable.

### 4. Validation & Error Matrix

- Invalid/revoked token: existing 401 handling; unknown project: HTTP 404.
- Oversized HTTP body: 413; invalid filename/backend size check/write failure:
  command error / HTTP 400, no draft reference for the failed file.
- Folder drop: localized notice. Successful files in a mixed batch are retained.
- Scope change/unmount: ignore late UI results and clean up their successful uploads.
- Cleanup failure (including disconnected transport/revoked token): log the failure;
  do not break drafting, sending or hide the original upload error. Cleanup is
  best-effort and may leave files behind; no automatic retry/sweep is scheduled.
- Invalid cleanup path: command error / HTTP 400; no generic project deletion.

### 5. Good / Base / Bad Cases

- Good: a Windows file is copied into the SSH server's runtime attachments folder
  and Pi receives its SSH-side absolute path. Duplicate basenames use separate
  directories; the Git working tree remains unchanged.
- Base: image thumbnails, clipboard images, ordinary text and session drags work.
- Bad: send a Windows path to WSL/SSH, expose arbitrary write/delete destinations,
  insert a completed upload into a newly selected session, or delete an attachment
  just because its composer unmounted or its submitted draft was cleared.

### 6. Tests Required

No permanent attachment regression test files were added. Verification in WSL
passed 211 Node unit tests, 19 Node integration tests, 174 Rust workspace tests,
frontend format/lint and the frontend build. `cargo fmt --all --check`,
`cargo check` and `cargo clippy --all-targets --all-features -- -D warnings` also
passed. An ad-hoc source check passed
POSIX/Windows/UNC and legacy mention round-trips, invalid references, cleanup and
submitted-file retention. Against the rebuilt Linux server, 33 real stdio RPC
checks passed runtime storage, exact bytes, Unicode names, duplicate isolation,
exclusive directory creation, the 10 MB boundary, empty files, invalid names/IDs,
cleanup path rejection, symlink safety and scoped deletion. Fixtures and runtime
files stayed under the ignored `target/attachment-verification/` directory.
Windows native behavior, real WSL/SSH connections, browser interaction and
write-failure cleanup remain unverified. Dedicated attachment coverage should also assert
filename/traversal/size rejection, duplicate names, auth/body limits, failed and
mixed batches, file-only sends, pending-send blocking, edits during upload,
A → B → A switching, hidden composers, modal drops and navigation prevention.
Verify drops on messages, conversation whitespace and the composer succeed; drops
on sidebars/headers/settings do not upload or highlight, and leaving the panel
clears its hint, on desktop, new-chat landing pages and WebUI. During preparation,
assert unchanged composer height/focus/viewport position, blocked normal and
follow-up sends, editable draft text and an accessible same-size spinner.
Cleanup-specific regression tests were not added. When authorized, assert failed
writes/late results are removed, removing an owned unsent mention cleans up,
remounting/switching preserves cached draft files, all submission modes retain
files before clearing the draft, and history references are never adopted for
cleanup. Check cleanup prefix/id/filename rejection and disconnected cleanup
failure without disturbing drafting or recovery.
Verify actual Windows main/session windows and wide/mobile WebUI, with Local,
WSL and SSH projects; lint/source review does not establish native drag behavior.

### 7. Wrong vs Correct

Wrong: store uploads in the Git working tree, insert a Host-side Windows path
into an SSH prompt, or forward a client-selected filesystem destination.
Correct: upload bytes into the selected environment's server-runtime attachment
folder and insert the returned absolute file mention.
