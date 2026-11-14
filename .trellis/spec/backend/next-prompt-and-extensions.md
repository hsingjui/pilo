# Next Prompt Prediction and Built-in Extensions

## 1. Scope / Trigger

Apply when changing Connection prediction settings, input assistance, Pi launch
selection, or Server-owned extension deployment. Prediction is not an Agent turn:
Pi JSONL remains authoritative and neither conversation storage nor the primary
model may be changed by a prediction.

Owners: `runtime/next_prompt.rs` (Host policy), `storage/next_prompt.rs` (SQLite),
`crates/pilo-server/src/extensions.rs` (deployment), and
`crates/pilo-server/extensions/next-prompt.js` (Pi model call). Desktop and WebUI
share `useNextPrompt`, `useNextPromptSettings`, settings fields and `ChatComposer`.

Connection settings list models using the independent Pi user catalog and shared
refresh in [Connection Model Catalog](./connection-models.md); project model caches
are not a source for Connection-owned choices.

## 2. Signatures

- Tauri `next_prompt_settings_get(connectionId) -> NextPromptSettings`;
  `next_prompt_settings_set(connectionId, enabled, model) -> NextPromptSettings`;
  `next_prompt_request(request: NextPromptRequest) -> ()`.
- Authenticated HTTP `GET /api/v1/next-prompt/settings?connectionId=...`;
  `POST /api/v1/next-prompt/settings` with `{ connectionId, enabled, model }`;
  `POST /api/v1/next-prompt/request` with the request directly, returning `{ ok: true }`.
- `PiloClient.loadNextPromptSettings(connectionId)`,
  `saveNextPromptSettings(connectionId, enabled, model)`, and
  `requestNextPrompt(request)` use those same Host services.
- Settings: `{ connectionId, enabled, model: null | { provider, id }, updatedAtMs }`.
- Request: `{ sessionKey, sessionId, requestId, generation, revision, cancel?: boolean }`.
- SQLite `connection_next_prompt_settings(connection_id TEXT PRIMARY KEY
  REFERENCES connections(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0
  CHECK(enabled IN (0,1)), provider TEXT NULL, model_id TEXT NULL,
  updated_at_ms INTEGER NOT NULL)`. A CHECK requires provider/model_id both null
  or both present.
- Pi `pi.start` adds `builtinExtensions: BuiltinExtension[]`, defaulting to `[]`.
  The internally tagged protocol enum uses `{ id: "next-prompt" }`,
  `{ id: "cache-keep-alive" }`, `{ id: "stream-guard" }`, `{ id: "model-catalog" }`, or
  `{ id: "ssh-workspace", config }`.
  Existing `extensions: string[]` still means inline source, not file paths.

## 3. Contracts

### Settings and Host requests

- No row returns `enabled: false`, `model: null`, `updatedAtMs: 0`. Null means
  follow the chat model. Disabling in the UI preserves the selected model.
- One UPSERT stores all fields and allocates `MAX(now, previous + 1)` as revision.
  Only a successful write broadcasts `{ type: "next_prompt_settings_changed",
  settings }`, with no sessionKey, projectId or process generation.
- The settings key is the original project's Connection, not the execution
  Connection. Local Pi for an SSH workspace resolves models in Local Pi's registry.
- Requests only look up an existing chat process; never ensure/start Pi. Host
  injects the saved model, requires enabled + matching revision for generation,
  and checks project, generation, initialization, idle flags and loaded built-in.
  Cancellation remains allowed for an old revision or a busy process.
- Before any private prompt, Host requires this process generation's raw
  `setWidget("pilo.next-prompt.ready.v1", ["ready"])` handshake. Starting,
  stopping or failing clears readiness. Missing/unsupported extensions must not
  turn `/pilo-next-prompt ...` into an ordinary user message.
- `ChatSessions::send_input_assistance` bypasses normal prompt work flags and
  idle-cache recency. Transport send has a 2-second timeout. Use a distinct
  `pilo-next-prompt-<requestId>-<cancel>` RPC ID: an uncorrelated response must
  not clear the main turn's pending prompt ownership.

### Extension and result channel

- Only a live `agent_settled` establishes the eligible Session/leaf snapshot.
  Host's `assistant_message_end` is its existing typed mapping, not a low-level
  assistant/tool turn end. Never fall back to `agent_end`.
- `/pilo-next-prompt <JSON>` is a registered RPC extension command. Its handler
  starts background `ctx.modelRegistry.streamSimple(...).result()`, then returns
  promptly. Both readiness checks require `streamSimple`. Do not use `complete`:
  its API-specific stream path does not resolve Pi virtual models, including when
  following the current chat selection. The provider-neutral path routes them
  without changing the chat model. It never
  calls `sendMessage`, `setModel`, or an independent provider SDK.
- Target is `registry.find(provider, id)` when explicit, otherwise `ctx.model`.
  Missing model/authentication produces unavailable; no silent fallback.
  Pi may resolve `.result()` with `stopReason: "error"` instead of rejecting;
  publish `unavailable` with `model_error`, not a normal `empty` result.
  Reject suggestions with `stopReason: "length"` even if their partial text passes
  validation; publish null text with `empty` / `output_limit`.
- Context uses `buildSessionProjection().entries` to honor compaction/context
  edits: bounded user/assistant text and summaries only. No tool records (including
  names/status), thinking, images, tool arguments/output, filesystem reads or full JSONL.
  Per-text clipping is 2,000 UTF-16 code units, retaining head + tail around an
  ellipsis without splitting surrogate pairs. Serialized JSON is at most 10,000
  characters, including escape expansion. Prioritize the latest user text and
  latest assistant text, each within half the serialized budget; further head/tail
  clipping keeps even escape-heavy messages within that share. Then add complete
  recent entries, including summaries and original intent when they fit. Skip an
  oversized older entry rather than stopping the search; emit in history order.
- One call: up to 4,096 completion tokens (capped to a known positive model
  limit), `maxRetries: 0`, AbortController timeout 15 seconds. Completion tokens
  may include reasoning, so the short visible suggestion is not a reason to use
  a 128/512-token ceiling. Keep API compatibility in Pi's `streamSimple` adapters:
  they map `maxTokens` to the appropriate wire field or omit it where unsupported;
  do not add provider-name heuristics or retry with a different payload in Pilo.
  Race the model result against the deadline: abort alone does not settle a
  provider Promise. A timeout publishes `unavailable` to every waiting request
  without waiting for provider shutdown; late resolution/rejection cannot publish
  again. A client cancel aborts without publishing. A request whose settled snapshot no longer
  matches (no settle, busy, session/leaf changed) is answered `cancelled`
  instead of leaving the client to its own timer.
  Prompt retains the body of [Claude Prompt Suggestion Generator v2](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-prompt-suggestion-generator-v2.md)
  with `Claude Code` replaced by `Pilo` and `Claude` role references replaced by
  `Assistant` (excluding the file metadata comment), with attribution/MIT notice
  inside the script. An appended instruction treats
  JSON as data, prioritizes the latest reply's ending and latest user request,
  forbids repeated/invented work, and matches the user's language. Clearly implied
  short confirmations and slash commands are allowed. No obvious next step means
  silence, not forced continue; the original sensitive-topic restrictions remain.
- Jobs deduplicate by Session ID + leaf ID + settings revision + resolved model
  identity. Up to 32 request IDs share one pending/completed job; cancel removes
  only that ID. When an unfinished job loses its last subscriber, abort and remove
  it so a later same-key request starts fresh; completed results remain reusable.
  New run, model selection, session navigation/compaction/shutdown resets the job
  and invalidates subscribed results.
- `setWidget("pilo.next-prompt.v1", [JSON.stringify(result)])` carries
  `{ requestId, sessionId, leafId: string | null, revision, text: string | null,
  status: "ready" | "empty" | "cancelled" | "unavailable" }`. This is a private
  Widget namespace, not a new generic Pi RPC/conversation event. Optional diagnostic
  fields are `reason`, `elapsedMs`, `stopReason`, `outputTokens`, and
  `reasoningTokens`; missing usage is null, never assumed to be zero. Pi's
  `usage.reasoning` is a subset of `usage.output`, not an additional token count.
  Reasons distinguish `empty_output`, `invalid_output`, `output_limit`,
  `model_error`, `model_call_failed`, `missing_model`, `missing_auth`,
  `unsupported_api`, `stale_snapshot`, and `timeout`. Core result decoding stays
  compatible with older extensions without these fields.
- Host logs `next_prompt.ready`, `next_prompt.result`, and `next_prompt.reject`
  through the bounded runtime diagnostics path. Shared frontend logs
  `next_prompt.client.*` for request, result, skip, discard, timeout, cancellation,
  and release after a received result. Desktop persists these via the existing
  trace command; WebUI client logs stay in its browser console, while its Host
  result/rejection stages persist in the desktop log too. Project only bounded
  correlation/state/reason/usage metadata, never text, thinking or raw errors.
- Shared decoder accepts one JSON line of at most 4,096 characters; safe integer
  revision; string IDs; nullable leaf; null or one-line text of 1–160 characters;
  no backticks. Extension rejects empty/overlong text and control/bidi characters
  after trimming, and rejects error, aborted or truncated completions. Keep code
  validation structural: language, word count, phrasing, single-sentence style and
  semantic suitability remain Prompt requirements, not regex blacklists or
  language-specific allowlists. Prediction text is not persisted or traced.

### Frontend lifecycle

- Trigger for an observed interactive Session with empty draft, no attachments,
  enabled settings, and no blocking UI, even when another Session is selected.
  Window blur, document hiding and selection changes must not cancel pending work
  or discard results. `createNextPromptSessionCache` owns per-runtime-session
  requests/results; WebUI retains observed sessions in its workspace hook and
  Desktop retains them in mounted chat controllers. Cache only in memory, retain
  at most 64 idle entries, and never evict a running turn or pending request to
  meet that limit. Controller/workspace disposal clears its cache.
- Only a live `assistant_message_end` (`agent_settled`) triggers generation.
  Resolve current Pi identity/model and verify idle state through the existing
  `get_state` RPC before requesting; this also handles a new WebUI draft whose
  startup completed after selection changed. Never start Pi or generate on mount,
  focus, state hydration, selection return or replay.
- Event handlers read committed options/settings: update the hook ref and cache
  contexts in layout effects, never during render. Distinguish view selection
  (`active`, display only), transport availability (`connected`) and temporary
  history loading (`loading`). Loading hides cached text without overwriting the
  retained session context; compare hydrated identity/editor/model changes once
  loading finishes, so a return to the same Session does not erase its result.
- Web passes `chat.identifiedSessionId`, not `chat.chatState.sessionId`: the latter
  is a statistics projection and does not carry the live Pi Session identity.
- Desktop uses the existing multiplexed runtime channel. Web feeds its existing
  socket frames into the shared hook, establishing a live sequence floor from
  hello/resync and advancing it per event. Replay can update settings, never
  trigger predictions. Foreground/reconnect reloads authoritative settings only.
  A healthy Web foreground return probes the existing socket instead of forcing
  reconnect; ping/pong is consumed by the adapter, never forwarded to this hook.
  Actual transport failure still invalidates work. See [Remote WebUI](./remote-webui.md).
- Result matching includes requestId, Session ID, Pi generation and revision;
  committed Connection/model/identity changes invalidate the matching entry.
  Input/attachments, Esc (even while pending), submit, run and dialog/readOnly
  clear only that Session's result and best-effort cancel its request. Selecting
  another Session is not an identity change. Settings changes/saving invalidate
  every cached Session on that Connection; transport failure/resync invalidates
  all results/work, retaining contexts for future live completions on the same
  client. Replacing the client drops contexts too. A failed settings save never
  restores an old suggestion. A 20-second client timer discards late work.
- `randomId()` is a correlation ID helper, not a pairing proof. It works on
  ordinary HTTP LAN origins where `crypto.randomUUID()` may not exist.
- Ghost Text uses textarea placeholder, never its value. Empty-draft sizing uses
  the configured rows, not placeholder scrollHeight; predictions must not enlarge
  the composer. The adoption control overlays the top-right with reserved text
  padding: `→ Tab` on fine pointers, a tap label on coarse pointers. Pure Tab only
  adopts with no modifiers, no IME composition and no existing completion menu.
  In the active Session, Tab also focuses the composer and adopts when focus is
  on the document body (or absent), no text is selected and no dialog/menu/listbox
  is open. Do not intercept Tab from another focused control or a handled/repeated
  key event. This shared behavior applies to desktop and WebUI, including hardware
  keyboards on mobile. Other keyboard behavior is preserved; adoption only fills
  the draft and never sends it.
- Shared settings fields use cached Host catalogs, preserve unknown configured
  identities, and do not spawn a model probe. Desktop has a Connection settings
  tab; desktop and wide WebUI expose the shared session-header settings popover
  (the unavailable hint lives inside it). Narrow WebUI (`isNarrow`, below 1024px)
  does not mount this button or popover; prediction and adoption remain unchanged.
  Neither composer displays a prediction settings icon. Use coarse-pointer 44px
  targets and the existing viewport/safe-area layout.

### Model stream idle guard

- Normal chat loads `stream-guard.js` through the same Server-owned deployment
  path on Local/WSL/SSH; desktop and WebUI use the shared assistant message UI.
  This is an idle watchdog, not an overall turn deadline or transport reconnect.
- Each `agent_start` enables monitoring, including automatic retries and
  `agent_before_settle` continuations through `agent.continue()`. Do not rely on
  `before_agent_start`: it only prepares the original prompt, not these later
  executions. Requests during prompt preparation or retry backoff stay unguarded.
  `before_provider_request` starts the timer before response headers/`message_start`;
  `provider_stream_event` and
  normalized `message_update` renew it. Any model event counts as progress, not
  just visible text. Assistant `message_end` disarms it before tool execution;
  long tools must not be aborted. Tool results cannot disarm an active request.
- Optional child environment `PILO_MODEL_STREAM_IDLE_TIMEOUT_MS` accepts a
  positive safe integer up to 2,147,483,647 ms; missing/invalid values use
  120,000 ms. No new UI setting or dependency is required.
- Expiry calls the current context's `abort()` once. Only a watchdog-owned
  `aborted` assistant message is replaced through Pi's `message_end` result:
  preserve content/usage, set `stopReason: "error"`, and prefix `errorMessage`
  with `PILO_STREAM_STALLED:`. Pi persists that replacement in its own JSONL.
  Shared UI localizes this prefix; ordinary errors and manual cancellation stay
  unchanged. Do not automatically replay a possibly side-effecting turn, and
  avoid retryable provider wording such as `timeout` in the replacement error.
- Manual abort removes the timer; late events cannot rearm an aborted/expired
  request. `agent_end`, session start/switch/shutdown clear all watchdog state.
  A subsequent turn gets a fresh signal/timer. Idle background model calls are
  not guarded. Provider cancellation must honor Pi's abort signal to settle.
- Do not assume SDK request timeouts cover SSE reads after headers. HTTP 200
  and a missing upstream error do not prove a terminal model event arrived;
  an incomplete-stream error after manual abort does not prove an earlier EOF.

### Fixed deployment

- Server embeds five single-file sources from `crates/pilo-server/extensions/`
  and deploys them once at startup into `<runtime-root>/extensions/`. Unchanged
  content is left untouched; missing/changed files use same-directory create-new
  temporary files, sync and atomic rename. Temporary names include PID + nonce;
  they are deployment staging only, never Session extension paths.
- `PILO_SERVER_RUNTIME_DIR` is an absolute writable runtime root. Local debug
  embedded Server and release binary launchers explicitly supply it. Default
  release Local root is Windows `LOCALAPPDATA/pilo/server`, or POSIX absolute
  `XDG_CACHE_HOME/pilo/server` / `HOME/.cache/pilo/server`, never an install directory.
  Debug Local uses `pilo-dev/server` instead. WSL/SSH launchers explicitly use
  `$HOME/.cache/pilo/server` for release and `$HOME/.cache/pilo-dev/server` for debug.
  See [Manual development runtime builds](./quality-guidelines.md#manual-development-runtime-builds)
  for manual builds and cache isolation.
- Server maps only typed built-in IDs to canonical absolute deployed paths.
  Before passing any built-in or inline extension path as `--extension`, the
  Server converts Windows verbatim drive paths (`\\?\C:\...` to `C:\...`) and
  verbatim UNC paths (`\\?\UNC\server\share\...` to `\\server\share\...`) to
  loader-compatible syntax. Bun's module loader may reject canonical Windows
  paths even when the file exists. Preserve ordinary Windows paths, spaces,
  Unicode, and all non-Windows paths; keep canonical paths for filesystem IO.
  Regression tests in `runtime_streams/pi.rs` cover both conversions and
  platform gating without requiring a Windows host for the string cases.
  Normal chat loads stream-guard, next-prompt and cache-keep-alive; model probe
  loads model-catalog (plus SSH tools
  only when required by its profile); parallel/direct Pi load only their profile.
  A disabled setting does not unload the script, but causes no prediction calls.
- SSH config is child-only `PILO_SSH_WORKSPACE_CONFIG` JSON:
  `{ label, remoteCwd, sshArgs, sshEnvironment }`. Remove inherited config before
  optionally setting it. Never replace text in shared deployed source.
- User-installed extensions remain Pi-native. Inline-source compatibility remains
  for other callers, but these production built-ins do not use it.
  `src-tauri/src/runtime/pi_ssh_workspace.js` is a legacy copy with no production
  loading reference. SSH regression tests must read the production source in
  `crates/pilo-server/extensions/ssh-workspace.js`, supplying child-only config
  through `PILO_SSH_WORKSPACE_CONFIG`. The mux fixture evaluates it with isolated
  imports and maps every filesystem operation into a private directory; simulated
  macOS `/tmp` pruning must never touch real sessions. Cover short socket paths
  despite a long `TMPDIR`, lazy creation, stale cleanup, recreation and shutdown.
- The model-catalog probe resolves defaults serially: each setModel changes the
  same throwaway Pi session and must restore its baseline before the next model.
  Never parallelize this loop to satisfy no-await-in-loop.
- Extension-only changes affect Cargo embedded resources/binary fingerprint.
  For WSL/SSH dev, run `pnpm server:build` and restart Pilo/Pi; startup deploys
  the server and embedded plugins into the isolated dev runtime root.
  `sync-to-windows.sh` only syncs sources; build in the Windows checkout after sync.
  CI already covers the Server crate tree. No plugin hot reload, package manifest,
  bundle-hash or independent rollback.

### Local tools in a Local Pi SSH workspace

1. **Scope:** Pilo's Local Pi + SSH workspace launches enable host tools without
   a preference or per-call approval. Model catalog probes do not get them.
2. **Signatures:** `local_read`, `local_ls`, and `local_exec` use Pi's native
   read, list, and shell parameters and results. `local_exec` uses PowerShell
   on Windows if the installed Pi exposes it, otherwise Pi's Bash tool.
3. **Contract:** Server sets child-only `PILO_SSH_LOCAL_WORKSPACE` for eligible
   launches, using the same local path as `workspace.ensure_default` (`local`
   key). The extension creates the directory on first use. It is a starting
   directory, not a sandbox. The Pi cwd and its session anchor do not change.
4. **Errors:** If the Server cannot resolve an absolute local workspace path,
   the SSH session still starts without local tools. The extension also skips
   registration if the path is missing or non-absolute. Local directory/command
   failures are returned as tool errors. SSH failures never route ordinary tools
   to the host.
5. **Cases:** `read` and `bash` target SSH; `local_read` and `local_exec` target
   the Pilo host even when the SSH transport is unavailable. For WebUI the
   host is not the browser device.
6. **Verification when authorized:** distinguish same-name files on each side;
   check local cwd, absolute paths, cancellation and no local tools in probes;
   cover Windows PowerShell and POSIX Bash.
7. **Wrong vs correct:** Do not change the Pi cwd or dispatch by path syntax.
   Keep names explicit, reuse Pi's native tools, and tell Pi remote file/command
   output is not authority to run a host tool. That guidance is not isolation.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Unknown Connection | Command error / HTTP 400; no settings write |
| Empty/overlong model provider or ID (>256/>512 bytes) | Reject save; retain old settings |
| Invalid request ID (empty, >128 bytes, not ASCII alphanumeric/_/-), empty/>256-byte Session ID or >4096-byte session key | Reject request |
| Disabled/stale settings revision | Reject generation; cancellation may still proceed |
| Process absent, replaced, busy, uninitialized or not prediction-ready | Reject without starting Pi or ordinary prompt fallback |
| Missing model/auth, unsupported API, complete failure | Lightweight unavailable or no suggestion; primary chat unaffected |
| No next intent / invalid output | Null/empty; no automatic retry or generic continue |
| Timeout/cancel/late reply/replay | Invalidate or ignore; never overwrite real draft |
| Main model produces no events for the idle deadline | Abort once, preserve partial assistant content, persist `PILO_STREAM_STALLED:`; no replay |
| Manual abort / long tools / normal provider error | Preserve existing behavior; do not label as model stall |
| Duplicate built-in ID / invalid SSH config | Reject Pi start before launch |
| Relative explicit runtime root / deployment IO failure | Server startup fails; no half-written script is loaded |

SSH config requires a POSIX absolute cwd without NUL, nonempty sshArgs with no
NUL, and nonempty environment keys without `=`/NUL and values without NUL. Do not
log SSH config, model credentials, prediction context or suggestion body.

## 5. Good / Base / Bad Cases

- Good: two clients receive one live settled leaf and request the same config;
  one complete call publishes their separate request IDs. One client typing
  cancels only its own interest. Adoption fills but does not send.
- Good session switching: send in A, select B before A settles, and generate/cache
  A's suggestion from its live completion. Switching during prediction retains
  the request; returning after completion shows the cached result without a new
  call. Typing or dismissing in B must not clear A. Hydration temporarily hides,
  but does not invalidate, A's cached result.
- Good stream recovery: an open SSE stream stalls, the watchdog settles the
  turn with a persisted error, and the user's next prompt completes normally.
- Base: default disabled or viewing idle history starts neither Pi nor prediction;
  absent cached models still allows follow-chat configuration.
- Bad: old Web replay, changed settings, typed draft, fork or new run cannot
  resurrect a suggestion. Explicit unavailable targets must not use another model.

## 6. Tests Required (When Explicitly Authorized)

`tests/integration/pi-stream-guard.test.ts` verifies first-event silence,
raw/normalized event renewal, long tools, tool-result isolation, manual abort,
late events, next-turn/lifecycle cleanup, ordinary errors and env bounds with
fake time. Simulate `before_agent_start` once, then a provider error, `agent_end`
and a retry's `agent_start`/`before_provider_request`: the retry must have a fresh
idle deadline, abort once and preserve partial content in the replacement error.
Also cover pre-settlement continuations, progress renewal, and background requests
during prompt preparation, idle time and retry backoff without a watchdog.
`tests/browser/chat-stream-guard.html` checks shared desktop/WebUI alerts in Chinese/English, 320px/wide and light/dark layouts, preserved partial
text, no stale processing indicator and unchanged ordinary errors.
A real Pi 1.3.0 RPC check against a local SSE mock also verified no-header and
partial-stream stalls, manual abort, recovery on the next prompt, one HTTP call
per prompt (no retry), `agent_settled`, and matching errors in Pi JSONL.
This is not a Windows desktop or real remote-provider validation.

`tests/integration/pi-next-prompt.test.ts` is included in `pnpm test:integration`
(and `pnpm test`). Its isolated Pi mock verifies timeout completion when abort
is ignored, shared subscribers,
completed timeout reuse, late success/failure suppression, per-request and final
subscriber cancellation, compaction invalidation and normal timer cleanup.
Its mock asserts the 15,000 ms deadline. The targeted suite passed all seven
cases after the timeout assertion was synchronized; this does not verify the
new token budget or diagnostic fields.

Remaining assertion points for future verification are not claims that these
behaviors have been run:

- Session cache: background completion after selection changes, switching while
  pending/ready, repeated A/B switches, per-session typing/Esc isolation, new-draft
  identity resolution after leaving during startup, loading/hydration retention,
  per-Connection settings invalidation, disconnect/resync and replay suppression.

- Storage: defaults, paired model fields, monotonic concurrent UPSERT revisions,
  Connection cascade, unknown/invalid identities and preserving model on disable.
- Extension: bounded escaped JSON, summary/context-edit handling and exclusion of
  private content; no JSONL writes; physical and virtual model selection (explicit
  and follow-chat), missing streamSimple readiness, target/auth failure; timeout/no retry; shared
  pending/completed calls and per-request cancellation across Session/leaf changes.
- Context/output optimization: latest user and assistant survive crowded history
  and escape-heavy text; long string/array messages and summaries preserve their
  endings and surrogate pairs; oversized older entries do not hide smaller older
  context; no tool records are sent. Accept structurally valid Chinese suggestions,
  dotted file paths, confirmations, slash commands and first-person wording without
  language/word-count filtering. Reject empty/overlong text, internal line breaks,
  backticks and control/bidi characters; semantic quality is a Prompt concern.
  These assertions have not been added or run without explicit authorization.
- Review fixes (not yet added or run): cancel the last subscriber, then submit a
  same-key request before/after the old provider settles; assert a fresh model
  call and no stale publication. Preserve completed-result reuse after release.
  Assert `length` with otherwise valid text returns `empty` / `output_limit` and
  null text; a resolved `error` returns `unavailable` / `model_error`.
- Diagnostics: assert result status, fixed reason code, elapsed time, stop reason
  and nullable output/reasoning usage survive Host logging, while suggestion,
  context, raw errors and unknown metadata never do. A provider returning only
  reasoning or `stopReason: "length"` must be distinguishable from a 15-second
  timeout. Frontend request/result/discard records correlate by request ID, and
  received-result release must not be mistaken for cancellation of pending work.
- Host: readiness absent/loading failure sends no private prompt; new generation
  clears readiness; private prompt response does not change main active-turn flags;
  stale/busy/history requests never start Pi or touch idle retention.
- Frontend: background completion triggers generation; blur/hiding preserves
  pending work and results; foreground return does not regenerate. Preserve
  replay/duplicate completion, late config/load/transport replies, input,
  pending Esc, run/dialog/model/fork invalidation; completion menu priority,
  IME and ordinary Tab navigation; LAN HTTP correlation IDs; adopt never sends.
- Authorized Windows desktop and real mobile WebUI: shared settings both ways,
  narrow wrapping/touch targets/safe areas/keyboard inset. WSL is not desktop validation.
- Authorized Local/WSL/SSH deployment: first install, unchanged reuse, missing-file
  repair, extension-only rebuild, atomic replacement, and two SSH session configs.
  The legacy SSH fixture alone does not verify the new deployed script.

## 7. Wrong vs Correct

Wrong: use a total-turn timeout, start monitoring only at `message_start`, enable
only at `before_agent_start` (missing retries/continuations), show only a frontend
error while Pi keeps running, or auto-resend a stalled tool turn.

Correct: monitor model-request inactivity from `before_provider_request`, stop
before tools, abort through Pi, and persist the error using `message_end` message
replacement. Preserve manual cancellation and require an explicit new prompt.

Wrong: `ensure()` an idle Session for prediction, send a private command without
knowing it loaded, or send it through normal chat prompt bookkeeping.

Correct: look up the existing process, require typed selection + readiness +
generation/idle checks, then use input-assistance send with its own RPC ID.

Wrong: `textarea.value = prediction`, direct `crypto.randomUUID()` on HTTP LAN,
or rewriting `ssh-workspace.js` to switch a Session's workspace.

Correct: use a separate ghost prop and explicit adoption, existing `randomId()`
for correlation, and child-process environment for SSH dynamic configuration.

Wrong: force WebSocket reconnect on every foreground return, or invoke
`modelRegistry.complete` on a virtual model selected for prediction.

Correct: probe the existing socket and reconnect only on failure; call
`modelRegistry.streamSimple(...).result()` so Pi resolves virtual routing.

Wrong: interpret a successful command RPC as a generated suggestion, size total
completion tokens by the short visible phrase alone, or inject `max_tokens`
directly for every API.

Correct: correlate command acceptance, extension result/reason/usage and client
accept/discard stages. Reserve reasoning headroom and delegate API fields to Pi.
The 4,096-token ceiling is informed by
[gamaraan/next-prompt-extension](https://github.com/gamaraan/next-prompt-extension/blob/main/next-prompt.ts),
whose default thinking margin is 3,072 tokens; this is reference evidence, not a
universal budget guarantee. Installed Pi 1.2.0 maps completion fields through
`maxTokensField`, gates Responses `max_output_tokens` with
`supportsMaxOutputTokens`, and omits that field on the Codex Responses path.
