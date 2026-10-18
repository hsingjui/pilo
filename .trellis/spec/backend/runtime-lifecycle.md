# Runtime Resource Lifecycle

## 1. Scope / Trigger

Apply when changing chat-turn ownership, process retention, runtime-event replay,
external session activity detection, or server shutdown.
Desktop and WebUI share `ChatSessions`; Local, WSL, and SSH use the same server lifecycle.
Frontend controller eviction alone is not backend process cleanup.

## 2. Signatures

- `ChatSessions::prepare(...)` / `ensure(...)` call `process(...)`, which invokes
  `prune_idle(retained_key)` before obtaining the requested process.
- `ChatSessions::send(session_key, command)` updates process recency and marks
  accepted work before waiting for Pi's first event.
- Frontend `sendPiPrompt(...)` / WebUI `rpcForSession<PiPromptResult>(...)` wait for
  the matching Pi `response`, not just successful command transport.
  `PiPromptResult` is `{ disposition: "started" | "queued" | "handled" }`;
  prompt preflight uses `PI_PROMPT_RPC_TIMEOUT_MS = 120_000`.
- `session_activity(...)` distinguishes process-confirmed `--session` paths from
  project-matched fallback candidates before reading their last JSONL message.
- `ChatSessions::state(...)` / `states()` read registered `SessionSnapshotReader`
  handles without awaiting the Pi startup/RPC session mutex. Remove readers with
  their processes on eviction, detach, project stop and global shutdown.
- `RuntimeEventBus::replay_after(sequence) -> Option<Vec<SequencedRuntimeEvent>>`:
  `None` means replay is incomplete and the WebUI must resync.
- `ChatSessions::start_idle_reaper()` starts one Host-owned 30-second sweep.
  `prepare` / `ensure` run readiness in owned tasks so HTTP cancellation cannot
  abandon a starting process in the shared registry.
- `ServerPiSession` records client/stream/task ownership before awaiting `pi.start`.
  Its `Drop` schedules bounded cleanup; failed `stop` retains the stream identity
  for retry. `PendingRequestGuard` removes cancelled client request senders.
- `PiProcess::stop()` drops stdin, waits for EOF shutdown, then force-kills only
  if necessary. `serve_stdio()` handles EOF, framing errors and stdout failure
  through cleanup; accepted Pi starts are registered in `pi_starts` at admission,
  and accepted Pi stops are registered in `pi_stops` before awaiting.
- `ServerWriter::send` / `blocking_send` share a 256-envelope / 64 MiB payload
  budget, including binary data and the frame currently being written.
- `ServerClient::stop()` closes stdin, waits for server cleanup, then force-kills
  only if necessary.
- `ServerManager::begin_shutdown()` closes new-connection admission and cancels
  pending connection setup/tests; `stop_all()` drains cached clients after admitted
  operations release their shared admission guards.

## 3. Contracts

- Admission reserves one slot for the requested chat and retains up to three
  other most recently used eligible processes. The 30-second Host sweep retains
  at most four eligible idle processes and expires observed idle entries after
  five minutes, without requiring another prepare/ensure. Active processes may
  exceed this budget; they become eligible only after their work ends.
  Read-only `get_*` RPC polling does not update recency or extend idle retention.
  WebUI model/thinking changes, fork, manual model refresh and cached extension
  command submission must ensure the target runtime first, just like Desktop.
  Keep background config refresh separate: polling must not respawn idle sessions.
  Capture the target session key across readiness awaits; late config results must
  not update the newly selected session.
- Never evict an active turn, compaction, uninitialized process, `no_session`
  session, or a session without a resolved JSONL path. A cloned `ChatProcess` Arc
  or a locked session protects in-flight startup/RPC work from eviction.
- WebUI explicit navigation away from a temporary chat (new draft, project
  change or session selection) stops its old session key. A late temporary start
  or MCP approval completion checks the active key and stops an abandoned runtime.
  Do not use effect cleanup on network/auth changes to kill live work. Browser
  disappearance still has no lease-based cleanup; temporary state cannot be
  restored and must not be silently included in the persisted-session TTL.
- Remove an evicted process under the registry lock, mark it closed, and stop it
  asynchronously. Late events from the old process must not reach a replacement.
  Persisted sessions are resumed by the existing prepare/ensure path. Eviction
  emits no `ProcessState` event for the removed session; the frontend only sees it
  disappear from `states()` and re-syncs when the next `ensure` respawns it and
  resets the generation.
- `ChatSessions::send` defaults a missing `prompt.streamingBehavior` to `"followUp"`
  for both desktop and WebUI. Idle prompts still start normally; a prompt racing
  autonomous Pi continuation queues instead of failing with "Agent is already
  processing". Preserve explicitly supplied behavior, and leave `steer`/`follow_up`
  commands unchanged. This does not permit prompts during active compaction.
- Desktop `useChatRuntimeEvents` adopts an active turn when live
  `user_message_start`/`assistant_message_start` arrives without one, after its
  generation/discard checks. Merely projecting autonomous output into the
  conversation leaves the composer incorrectly idle and disables queue/stop.
  Compaction/completion events alone must not create a turn. WebUI already derives
  composer activity from the shared conversation reducer.
- `prompt` and `compact` mark their respective busy flags before `send_rpc`;
  transport failure rolls back only flags that were previously idle. Compaction
  is tracked separately so `CompactionEnd` cannot clear an ongoing agent turn.
  `ChatSessionState` exposes both `activeTurn` and `compacting` from `state()` /
  `states()`. The shared `runtimeActivityFromStates` includes running compactions
  in Desktop/WebUI/mobile sidebar activity. Frontend `compacting?: boolean`
  tolerates older Host responses. Do not set `activeTurn` for compaction or widen
  `chatRuntimeHasOpenTurn`: turn adoption and prompt handling need the real turn.
- A `prompt` that flips an idle active-turn flag records its command id as the
  flag owner; `send` injects `pilo-prompt-<n>` when the caller sends none. Pi
  echoes the id in its prompt response. The owned flag rolls back when that
  response is `success:false` (preflight rejection) or carries
  `data.disposition == "handled"` (extension command or input handler consumed it
  without a turn). `started`/`queued` keep the flag, and a response for a prompt
  that did not own the flag never clears a running turn. Live user/assistant/retry
  starts release pending prompt ownership; a later `handled` response must not
  clear an extension-started turn.
- Both frontends end optimistic activity on rejected prompt responses. For
  `handled`, query Host state: clear the local pending prompt only if no real
  turn is active; do not auto-title a consumed prompt. Older Pi responses without
  `data.disposition` keep the existing accepted-prompt behavior.
- Responses with `pilo-` or `remote-` ids are caller-correlated: command rejection
  rejects that RPC, not the whole session. Runtime errors and terminal process
  events reject all pending RPCs for that session and clear activity, compaction,
  and retry UI. MCP approval intentionally interrupts initialization; preserve
  its session-keyed prompt for approval/resume instead of displaying a fatal turn.
- Explicit `stop`/`detach` remove and close the process, then asynchronously emit
  `ProcessState::Stopped` with its generation. Notification must not block detach
  on a session lock. Under the registry lock, skip the old notification when a
  replacement occupies the key. This differs from silent idle-cache eviction.
- A graceful `Stopped` is expected teardown, not a crash: the Desktop ends the
  active turn without an error and without restarting Pi. An unexpected `Failed`
  shows a Desktop interruption warning without a reconnect button or automatic
  runtime restart: every open controller receives server disconnect failures, so
  auto-recovery restarts all interrupted Pi sessions. The next user-submitted
  prompt ensures the original persisted runtime on demand. Desktop draft prewarm
  in `ChatPage` must skip `recoveryState.status === "failed"`, even when
  `ChatSession.sessionPath` is absent; switching back is not permission to restart.
  Temporary sessions remain unrecoverable. Listener setup failures use the same
  warning-only behavior.
  WebUI network auto-reconnect and attachment to an already-running turn are unchanged.
  `Stopped` still rejects that session's pending RPCs and refreshes activity on both
  frontends.
- A disappeared/stopped/failed Host runtime is not successful turn completion for
  unread markers. WebUI rechecks Host state before sending after failure, resumes
  the original persisted path, and keeps asynchronous sends/recovery session-scoped.
- Pi JSONL persists completed messages, not streaming deltas. A live process with
  an explicit `--session` path is not subject to the 60-second stale-tail cutoff.
  Project-only inferred paths still use that heuristic; their ownership is not
  certain. Parse complete final message lines backwards with bounded buffers,
  including messages larger than 128 KiB, without retaining their text/images.
  When no `message` entry exists yet (header-only file), a named live process still
  counts as active instead of releasing the session as idle. Native Windows
  external-process discovery is still unsupported; only running or starting Host
  paths are excluded from external detection.
- Replay retains at most 2048 events and 16 MiB of **serialized payload bytes**.
  This is not an exact RSS budget for Rust `Value` objects or live transport queues.
  Count bytes without allocating a second JSON buffer.
- The shared Web live ring retains at most 512 events and 64 MiB serialized bytes.
  Each receiver has a sequence cursor; watch notifications contain no payload.
  Eviction or an event over the live limit reports lag and triggers resync.
  Server-client queues retain up to 2048 events and 64 MiB payload bytes per
  stream; binary attachments count too. Reserve a terminal control-event slot;
  overflow disconnects that stream rather than silently dropping its output.
  These limits exclude in-flight consumers and object-allocation overhead.
- An event exceeding the replay budget but fitting the live budget is delivered
  live and clears replay. A client behind that event receives a gap even when
  the replay deque is empty; a client
  already at the latest sequence receives an empty replay. Sequence zero retains
  the existing whole-buffer bootstrap behavior.
- Sequence allocation, replay insertion, and Web broadcast publication share a
  lock to preserve ordering across concurrent sessions.
- Pi stop gives stdin EOF one second for Pi shutdown hooks, then a bounded
  one-second process-tree fallback and one-second direct-child reap. Unix Pi
  starts in a fresh process group and fallback uses `/bin/kill -KILL -- -<pid>`;
  Windows fallback uses `taskkill.exe /PID <pid> /T /F`. This is not a Windows
  Job Object: already-detached descendants and abrupt server crashes are not
  guaranteed to be contained. Never kill unrelated processes by executable name.
- Register each admitted `pi.start` cancellation sender by request ID and stream
  ID before spawning its dispatch task. Stop cancels all pending starts for that
  stream, even if no child exists yet. Cancellation is checked before dispatch
  polling; a cancelled start returns `request_failed` with
  `Pi stream startup cancelled`. Hold the Pi process registry lock while cancelling
  starts and removing children, so a concurrently polled start either remains
  cancellable or has already registered its child for the same stop to reap.
  Remove start registrations on dispatch completion and clear them on shutdown;
  the ordinary 64-request admission limit bounds this registry.
- Natural stdout cleanup checks the original stdin Arc's Weak identity under the
  Pi registry lock and never cancels pending starts. Explicit stop owns and joins
  that instance's stdout/stderr tasks before ACK, including when natural cleanup
  already removed its child. Same-stream replacement aborts and joins leftover
  output tasks before spawning; a stopped instance cannot publish late exit/log
  events into its replacement. Reader task registration and child registration
  share the Pi registry lock, and accepted stop tasks own removed reader handles
  before any await. Shutdown aborts all registered readers.
- Abort and join pending server requests before draining Pi processes: an in-flight
  `pi.start` must not create a process after cleanup passes the registry. Removal
  from the live registry and registration in the stopping JoinSet have no await
  between them. Drain accepted stops and live children concurrently before exit.
- Ordinary server request admission is nonblocking and capped at 64. Pi/terminal/
  watcher stop commands have a separate 64-slot allowance. Overload returns
  `server_busy`; if the rejection cannot be queued within one second, clean up
  the connection rather than indefinitely stop reading stdin. Client Pi stop
  retries capacity rejection within its five-second cleanup deadline.
- Count server output bytes without making another serialized buffer. Oversized
  responses return `output_too_large`; Pi stdout is bounded while reading, not
  after allocating a complete line. An over-limit line terminates that stream.
  Queue budgets exclude waiting producers and object-allocation overhead.
- Event coalescing ticks only while a Pi stream has buffered events. Reset the
  16 ms window when an empty buffer first receives a delta; idle streams do not
  continuously wake their tasks.
- Abort and join the client writer to drop server stdin. Keep the reader alive while
  waiting for EOF cleanup (5 seconds); fallback kill/wait has another 1-second bound.
  Stop connection servers concurrently and do this even if earlier app teardown
  exceeds its 5-second grace period.
- Begin server-manager shutdown before session/terminal teardown. Cached live
  clients remain usable for stop RPCs, but cold/retry connections and connection
  tests fail with `pilo-server manager is shutting down`. Use shared admission
  guards and per-connection locks so slow SSH/WSL setup does not serialize other
  environments. Register shutdown notification before checking the atomic flag;
  cancel connection-lock waits, setup and test pings when shutdown begins.
  Exclusive admission in `stop_all()` prevents cache insertion after its drain.
  The desktop bounds this final server cleanup to 8 seconds, independently of
  the preceding 5-second resource teardown, and proceeds to exit on timeout.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Eligible idle cache exceeds budget | Stop oldest eligible processes on admission or the next 30-second sweep |
| Persisted idle process reaches five minutes | Sweep expires it; next ensure resumes its JSONL |
| WebUI model/thinking/fork/manual refresh after eviction | Ensure the target before RPC; background polling stays read-only |
| Old stdout finishes after explicit stop | Joined before ACK; cannot cancel or emit into a same-stream restart |
| Read-only state/model polling | Does not extend idle TTL |
| WebUI explicitly leaves temporary chat | Stop the old key, including late startup/approval completion |
| Title-generation HTTP timeout or unregistered worker error | Session drop schedules cleanup; no abandoned stream ownership |
| Stop while Pi start is probing or waiting for the process registry | Cancel the pending dispatch; it cannot spawn a late child. Fresh starts after the stop ACK remain valid |
| Ordinary server request saturation | Return server_busy; keep independent stop capacity |
| Pi stdout exceeds line limit | Stop the stream without reading the full oversized line |
| Idle session evicted | No stop event; `states()` drops it; next `ensure` respawns and resets the generation |
| Live/temporary/unsaved/in-flight session | Keep it, even above budget |
| Running Host compaction without an active turn | Sidebar keeps its running marker on Desktop and WebUI/mobile; completion clears it unless a turn remains active |
| Extension resumes after compaction | Desktop adopts the live turn; queue and stop remain available |
| Prompt races autonomous continuation | Missing `streamingBehavior` defaults to `followUp`; explicit behavior is preserved |
| Prompt response rejects | Reject the matching caller; release its optimistic activity |
| Prompt response is `handled` | Query Host activity; clear pending UI only without a real turn; skip auto-title |
| Correlated `remote-` command fails during a turn | Fail that RPC only; do not clear the running turn |
| Explicit stop/detach | Remove immediately; notify asynchronously unless replaced; no completion unread dot |
| Graceful `stopped` during a turn | Desktop ends the turn silently; no error, no runtime restart |
| Unexpected `failed` during a turn | Desktop surfaces an interruption warning; reconnect on the next prompt, no reconnect button or automatic Pi restart |
| WebUI runtime fails | Clear turn/compaction/retry; next send checks Host and resumes original path |
| Confirmed external `--session` tail is older than 60 seconds | Infer activity from the final message, not age |
| External probe fails | Keep last activity; unknown is not completion |
| Background idle stop fails | Log warning; do not block another chat launch |
| Replay byte/count eviction | Older sequence returns `None`; WebUI resyncs |
| Event over 16 MiB replay limit but within 64 MiB live limit | Deliver live; clear replay and expose the gap |
| Web live count/byte eviction or event over live limit | Report lag; request snapshot resync |
| Server stream count/byte overflow | Reserved disconnect event; remove stream sender |
| Session startup/RPC lock held | State queries use the independent snapshot reader |
| Server stdin EOF or invalid frame | Cancel requests, clean up children, finish writer |
| Server ignores EOF | Bounded force-kill fallback |
| Shutdown during cold connection or connection test | Cancel setup/test; reject new connections, keep cached clients for stop RPCs until drained |
| Final server cleanup exceeds 8 seconds | Log timeout and continue desktop exit |

## 5. Good / Base / Bad Cases

- Good: use many persisted sessions; idle processes are reclaimed on subsequent
  admission and resuming an evicted session loads its Pi JSONL.
- Base: a few idle sessions remain warm; running turns and temporary sessions survive.
- Bad: killing the server before closing stdin skips its child cleanup and can orphan Pi.

## 6. Tests Required

Server-manager regression coverage checks pending connection-lock cancellation,
parallel admission, cancellation of an in-flight operation, rejection before work
is polled, rejection of connection tests after shutdown, and cached-client use
during teardown followed by drain. Native Windows exit timing remains manual.

Earlier lifecycle work passed WSL workspace tests and static checks.
An ad-hoc stdio check using a slow fake login shell and
fake Pi confirmed cold-probe cancellation without a late child, successful
same-stream restart after stop ACK, and 50 immediately paired start/stop requests
with no remaining Pi children. Native Windows behavior remains unverified.
The following targeted regressions remain to be added with explicit authorization:
- Sweep over-budget sessions after their live turns finish, expire eligible idle
  sessions, ignore read-only recency updates, and preserve active/temporary/
  unsaved/in-flight exclusions. Exercise resumption on Desktop and WebUI, including
  model/thinking changes, fork, manual model refresh and cached extension commands
  after TTL eviction. Switch sessions while readiness/config RPCs are pending;
  results must not update the newly selected session.
- Cancel title generation and readiness at different await points, fail a parallel
  worker's first prompt, lose a start acknowledgement, and cancel stop after its
  acceptance. Stop during cold toolchain probing and before the start task's first
  poll; assert the original start receives a cancellation error, no late child
  appears, and a fresh start after the stop acknowledgement still succeeds.
  Assert no child is outside both live and stopping registries. Delay the old
  stdout reader and stderr delivery, stop and await ACK, then restart the same
  stream; the new start and process must survive without old terminal/log events.
  Also replace a stream during natural EOF cleanup and cancel an accepted stop
  while it owns reader handles.
- Verify EOF hooks precede force-kill, forced Unix group/Windows tree cleanup,
  server stdout failure, request saturation with stop/EOF still responsive,
  queued/in-flight byte permit release, oversized responses and unterminated
  oversized Pi stdout lines. Native Windows/macOS and Local/WSL/SSH remain pending.
- Navigate away from a WebUI temporary chat during startup and MCP approval;
  stop only the abandoned key. Network/auth changes must not stop running work.
- `chat_sessions/idle_cache.rs`: LRU order, retained key, busy/compacting/initializing/
  temporary/unsaved/in-flight exclusions, busy-flag rollback on failed send.
- `chat_sessions/event_sink.rs`: prompt rejection rolls back only the owning
  prompt's active-turn flag; a success response releases ownership without
  clearing the turn; live start transfers ownership before a `handled` response;
  compaction completion does not clear an active turn.
- Prompt/UI regressions: rejected preflight releases optimistic activity; `handled`
  removes its pending user and permits the next send; extension-started activity
  survives `handled`; responses without disposition remain compatible. Verify
  desktop and WebUI, including mobile WebUI session switching while awaiting ACK.
- Explicit detach returns without waiting for startup/RPC locks, eventually emits
  stopped for the removed generation, and never notifies an existing replacement.
  Stopped/failed/disappeared Host runtimes do not create completion unread dots.
  Desktop must not show a runtime error or restart Pi for a graceful `stopped`,
  while `failed` shows an interruption warning without a reconnect button.
  Disconnect a server with multiple open sessions, restore the connection, and
  assert no controller calls `ensure()` automatically. Switch away from and back
  to an interrupted draft with no `ChatSession.sessionPath`: `prepare()` must not
  run either. Submitting a new prompt resumes only that session and does not
  replay the interrupted prompt.
  Temporary sessions expose no reconnect action.
- WebUI command rejection with a `remote-` id does not end an unrelated active turn;
  terminal process events reject only that session's RPCs. MCP approval resumes
  the original session after switching away. Runtime recovery preserves its path.
- External activity: a confirmed owner with an old open tail remains active;
  fallback candidates retain stale-tail filtering; a terminal message larger than
  128 KiB remains idle; trailing metadata/partial lines do not hide the last message;
  a named live process whose file has no `message` entry yet stays active.
  These assertion points are requirements, not a claim of checks already run.
- Prompt forwarding: absent `streamingBehavior` becomes `followUp`, explicit
  `steer`/`followUp` survives, and non-prompt commands are unchanged.
- Sidebar compaction regression (pending authorization): running + compacting +
  no turn is active; compacting false is idle; a remaining active turn stays active;
  stopped/failed runtimes are idle; older responses without compacting retain
  turn-only behavior. Check Desktop and WebUI/mobile, including session switching.
- Desktop manual regression: compact with extension-driven `continue`, then send
  steering/follow-up messages and stop; verify running state until agent settles.
  Late compaction/completion or stale/discarded generation events must not adopt
  a running turn. Repeat prompt-race behavior through WebUI.
- `events/mod.rs`: byte eviction before count limit, oversized live delivery, empty
  replay gap, latest-sequence empty replay, concurrent replay/broadcast ordering,
  existing sequence/count contracts.
- Pending explicit test authorization: byte/count overflow including binary-only
  events, live oversized-event gaps, notification coalescing without lost events,
  cursor ordering, and state queries while startup/RPC holds the session mutex.
- `server_client/tests.rs`: a fake server completes its EOF cleanup before stop returns.
- `pilo-server/tests/stdio_protocol.rs`: a real fake-Pi child is reaped after server EOF.
- Windows desktop shutdown and Local/WSL/SSH resumption still require platform testing;
  Unix process tests do not establish Windows descendant-process behavior.

## 7. Wrong vs Correct

```rust
// Wrong: abruptly kill the server, bypassing its Pi/PTY cleanup.
process.reader_task.abort();
process.child.kill().await;

// Correct: drop the stdin owner and let EOF run server cleanup first.
process.writer_task.abort();
let _ = process.writer_task.await;
// Bounded wait, then kill only if the server does not exit.
```

Do not hold a global exclusive mutex across remote connection setup, or await
that setup indefinitely from shutdown. Use shared admission with cancellation,
then drain under exclusive admission and keep a final desktop timeout.

```typescript
// Wrong: successful transport does not mean Pi accepted the prompt.
await client.sendChatCommand(key, { type: "prompt", message });
// Correct: correlate Pi's response and handle rejection/consumption.
const result = await rpcForSession<PiPromptResult>(
  key, { type: "prompt", message }, PI_PROMPT_RPC_TIMEOUT_MS,
);
// If handled, consult Host activity before ending optimistic UI.
```

Do not use event count alone as a memory budget: one RPC result can contain an
entire transcript or large tool output. Combine count and payload-byte limits.
