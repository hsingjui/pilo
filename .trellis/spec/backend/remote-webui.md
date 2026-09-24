# Remote WebUI & Event Hub

> Executable contracts for the Remote WebUI adapter, its auth model, and the
> multi-subscriber runtime event bus.

---

## 1. Scope / Trigger

Apply code-spec depth when a change touches:

- The HTTP/WebSocket Remote adapter (`runtime/remote/*`).
- The `RuntimeEventBus` broadcast/replay contract (`runtime/events.rs`).
- `remote_host_config` / `remote_pairing` / `remote_devices` SQLite tables.
- The transport-neutral `PiloClient` boundary (`src/lib/pilo-client.ts` + adapters).

The Remote adapter is a **transport adapter into the same Host** — it must not own
session state, and it must not call Tauri-specific types from Application code.

---

## 2. Signatures

### Tauri commands (desktop transport)

Parsed in `runtime/commands/remote.rs`; registered in `lib.rs`:

```rust
remote_host_state()                       -> RemoteHostState
remote_set_enabled(enabled: bool)         -> RemoteHostState
remote_pairing_regenerate()               -> RemoteHostState
remote_device_revoke(deviceId: String)    -> RemoteHostState
```

`RemoteHostState` (`camelCase`): `enabled`, `running`, `port`, `baseUrl?`,
`pairingUrl?`, `pairingExpiresAtMs?`, `lastError?`, `devices[]`.

### HTTP routes (`runtime/remote/api.rs`)

Public:

```text
GET  /api/v1/health          -> { ok, service }
POST /api/v1/auth/pair       -> { token, device }        body: { secret, deviceName? }
```

Authenticated (`require_auth` middleware):

```text
GET  /api/v1/bootstrap       -> { projects, chatSessions, latestSequence }
GET  /api/v1/sessions?projectId=...
GET  /api/v1/history?projectId=&sessionPath=&startMessage=&messageLimit=&includeMessageIndex=
GET  /api/v1/models?projectId=... -> ProjectModelCache | null  (Host-cached Pi model catalog)
POST /api/v1/chat/start      -> PiSessionSnapshot        body: ChatStartRequest
GET  /api/v1/chat/state?sessionKey=...
POST /api/v1/chat/rpc        -> 204                      body: { sessionKey, command }
GET  /api/v1/files/search?projectId=&query= -> string[]  (read-only @ mention search)
GET  /api/v1/events          -> WebSocket upgrade
```

`fallback` serves the embedded Mobile WebUI from the Tauri asset resolver.

### WebSocket protocol

- Subprotocols: `pilo`, `pilo-token.<token>`.
- Client may pass `?after=<sequence>` for replay.
- Server frames: `{ type: "hello", deviceId, latestSequence }`,
  `{ type: "events", events: SequencedRuntimeEvent[] }`,
  `{ type: "resyncRequired", latestSequence }`.
- `SequencedRuntimeEvent` = `{ sequence, ...RuntimeEventEnvelope }` (flattened).
- Token is read from `Authorization: Bearer` **or** the `pilo-token.` subprotocol
  — never from the URL query.

### Storage (`runtime/storage/remote.rs`)

```text
remote_host_config(id=1, enabled, port)
remote_pairing(id=1, secret_hash, expires_at_ms, consumed_at_ms)
remote_devices(id, name, token_hash, created_at_ms, last_seen_at_ms, expires_at_ms, revoked_at_ms)
```

---

## 3. Contracts

- **Secrets**: pairing secret and device token are 32 random bytes, URL-safe
  base64. Only SHA-256 hashes are persisted. Plaintext never reaches the DB or logs.
- **Pairing TTL**: 5 minutes, single-use (`consumed_at_ms` set on success).
  A successful pair rotates the link (`regenerate_pairing`).
- **Device token TTL**: 30 days absolute. Revoked or expired tokens fail auth
  immediately; live WebSockets re-check every 15 s and on `auth_generation` change.
- **Auth scope**: authenticated == full MVP capability. No roles/capabilities yet.
- **RPC allowlist**: only chat-mutating/querying commands are forwarded (see
  `ALLOWED` in `api.rs`). No generic command proxy; Terminal/Files/Git are not exposed.
- **`@` mentions**: `GET /api/v1/files/search` is the only Files surface. It
  forwards the host `fs.search` and returns file **paths only** — no reads,
  writes, or directory listing.
- **Model catalog**: `GET /api/v1/models` is read-only and returns the
  Desktop-maintained `project_model_cache` snapshot (or `null` when absent).
  Remote must not spawn its own Pi probe session for the draft composer; the
  Desktop client keeps the cache fresh.
- **Attachments**: images only (`png/jpeg/webp/gif`), ≤ 10 MB each, ≤ 20 MB total,
  ≤ `MAX_CHAT_IMAGES`. Reuses the existing chat image contract.
- **Replay gap semantics**: `replay_after(seq)` returns `None` (gap → client must
  resync from snapshot) **iff** the oldest buffered sequence is greater than
  `seq + 1`. `seq == 0` always replays the whole buffer.
- **Backpressure**: each Web subscriber has a bounded broadcast channel; a lagging
  subscriber receives `Lagged` and is told to `resyncRequired` instead of blocking
  the runtime. Desktop Tauri channel is another subscriber and is unaffected.

---

## 4. Validation & Error Matrix

| Condition                                   | Result                                          |
| ------------------------------------------- | ----------------------------------------------- |
| Missing/invalid Bearer or `pilo-token`      | `401 authentication required`                   |
| Unknown/expired/revoked token               | `401 invalid or expired device token`           |
| Invalid or expired pairing secret           | `401 invalid or expired pairing link`           |
| Too many auth failures from one IP          | `429 too many authentication attempts`          |
| RPC `type` not in allowlist                 | `400 chat command '<type>' is not available…`   |
| Non-image attachment / wrong mime / too big | `400 …` (see `validate_remote_images`)          |
| Unknown project/session                     | `404`                                           |
| Handler `Result::Err(String)`               | `400` for chat start/rpc, `500` for internal    |
| Request body over `MAX_REQUEST_BYTES`       | rejected by `DefaultBodyLimit`                  |
| Handler over 45 s                           | `408` (Tower timeout)                           |
| WS buffer lag                               | `resyncRequired`, connection kept               |

---

## 5. Good / Base / Bad Cases

- **Good**: Desktop + two Web clients observe the same session; each subscriber
  gets ordered identical sequences; a brief disconnect replays from `after`.
- **Base**: Remote disabled → no listener, no port, Desktop path unchanged.
- **Bad**: A Web client that stops reading must **not** stall Pi streaming; it is
  dropped to `resyncRequired` after the broadcast buffer fills.

---

## 6. Tests Required

Assertion points (inline `#[cfg(test)] mod tests`):

- `storage/remote.rs`: config round-trip; pairing is one-time + expires;
  authenticate rejects revoked and expired devices.
- `remote/auth.rs`: hashes are 64-char hex and never equal the plaintext;
  device names are bounded to 81 chars with `…`.
- `remote/api.rs`: `validate_remote_rpc` rejects `terminal_write`/`fs_read_file`
  and non-image attachments; `token_from_headers` reads `pilo-token.` from the
  subprotocol.
- `runtime/events.rs`: web subscribers share one ordered stream with matching
  sequences; `replay_after` reports a gap only after the buffer has evicted
  `seq + 1`; replay slice after eviction returns exactly the latest event.

---

## 7. Wrong vs Correct

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

## Design Decisions

- **No daemon / no new crate (Phase 1).** Axum + Tower-HTTP live inside
  `src-tauri`; Application logic is `runtime/chat_service.rs`, not a God service.
- **Manager owns the listener.** `RemoteServerManager` is the single place that
  starts/stops the listener, persists `enabled`, and restores on app start.
  Remote OFF means the listener does not exist.
- **EventHub over EventBus.** `RuntimeEventBus` keeps the Tauri `Channel`
  subscriber and adds a bounded `broadcast` sender plus a bounded replay deque;
  replay/sequence live in the adapter layer, never in the Pi runtime.
- **Transport-neutral client.** `PiloClient` is implemented by `TauriPiloClient`
  (invoke/channel) and `WebPiloClient` (fetch/WebSocket); only Remote-MVP features
  are migrated — Files/Terminal/Git stay Tauri-only.
