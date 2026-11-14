# Hook Guidelines

> Custom hook conventions.

---

## Naming & Location

- File names are kebab-case: `use-chat-runtime.ts`, `use-keyboard-shortcut.ts`.
- Exported hook is camelCase starting with `use`: `useChatRuntime`.
- App-shell orchestration hooks live in `src/components/app/` (`use-app-catalog`,
  `use-app-chat-workspace`, `use-opened-chat-controllers`).
- Feature-local hooks live in the feature folder (`src/components/chat/use-*.ts`).
- Cross-cutting hooks live in `src/lib/`.

## Patterns

- One hook per file. Return a typed object (`return { ... }`) or a tuple for
  simple `useState` wrappers.
- Depend on refs for values that must not retrigger effects; the chat runtime
  leans on refs (`activeTurnSessionIdRef`) to avoid stale closures.
- Clean up subscriptions and timers in the effect's return function:

```ts
useEffect(() => () => window.clearTimeout(resetTimer.current), []);
```

- Subscribe to backend streams once per session with `listen` inside `useEffect`
  and return the unlisten handle. `listen` returns `Promise<UnlistenFn>`; guard
  against set-after-unmount.

### External refresh generations

Host configuration revisions and WebUI replay/resync keys intentionally retrigger
loads even when they are not data inputs to the effect. Keep these dependencies;
removing them breaks CLI-driven updates or recovery. Follow `useRemoteTheme` and
the settings panels: scope an explained `react/exhaustive-effect-dependencies`
exception to just that effect, then re-enable the rule. Do not disable global
rules or suppress genuine missing closures (`react-hooks/exhaustive-deps`).
Destructure stable callbacks before using them in an effect and its dependency
array rather than capturing an entire hook result object.

## When to make a hook vs. a plain function

- **Hook** when it needs React state, effects, refs, or context.
- **Plain function** when it is pure. Logic that is testable without React
  belongs in `src/lib/*.ts` and is unit-tested in `tests/` — don't bury it in a
  hook. Example: `conversation-reducer.ts`, `chat-submission.ts`.

## Data Fetching

There is **no TanStack Query / SWR**. Fetch by calling typed `src/lib` functions
inside `useEffect` or event handlers, and store results in local state or a
custom external store. (`AGENTS.md` lists TanStack Query as intended, but the
codebase does not use it.)

## History Reloads and Errors

- `useChatConversation.refreshHistoryIfStale` compares the latest index
  fingerprint with both the successful response and the index captured by that
  request. An unchanged stale index must not restart a successful history read.
  Remember failed request fingerprints even when an older snapshot exists; the
  same failure waits for manual retry or a changed index instead of looping.
- Preserve successfully replayed messages on index mismatch. Desktop and WebUI
  show `chat.historyIndexStale` through the shared `ChatComposer.statusError`.
  Warn only while idle and while the index still equals the one captured at
  load time. Gate the notice with `useHistoryIndexWarning`: an idle mismatch
  must persist for two seconds in the same session, because the fresh history
  read can finish before the sidebar index updates. Do not delay history
  reconciliation or read errors. Desktop read failures expose the normalized
  backend detail alongside the existing error view/retry button; WebUI retains
  its fatal-error notice.
- When verification is authorized, cover stale index A returning history B
  (one load, stable messages, notice after two seconds), index catch-up before
  the delay (no notice) and after it (notice clears), switching sessions or
  starting a turn during the delay, unchanged failure after a prior success
  (no automatic retry), manual retry, and later index changes (reload allowed).

## Matching Host Chat Runtimes

- Desktop and WebUI use `runtimeSessionPathKey` for sidebar activity and
  `findReusableChatRuntime` for adoption. A Windows index path such as
  `C:\Users\me\.pi/agent\sessions\a.jsonl` must match Pi’s
  `C:\Users\me\.pi\agent\sessions\a.jsonl` in the same project.
- Normalize separators only for the comparison. Keep the original index path
  for history and persistence, and leave absolute POSIX paths unchanged.
- A Desktop history window ending in an interrupted assistant is provisional:
  a WebUI turn can still be running before the sidebar sees its runtime. Match
  it against current Host runtime states before publishing. If idle, re-read
  once without the index fingerprint before showing an interruption; the turn
  may have finished after the first read. Keep the live-update guards in place.

## Manual Session Refresh

- Desktop and WebUI expose refresh in each left-sidebar session row menu,
  including the mobile navigation drawer, not in the top-right session header.
  The row uses `useSessionRefresh` for pending state and localized errors. Disable
  running rows; reject requests while compaction, retry, submission, an extension
  dialog or history load is active. Running sessions do not queue a
  refresh for later. Recheck Host runtime activity and Pi streaming/compaction
  before requesting history, since the menu state can lag behind the process.
- WebUI viewport readiness uses the same route key as the mounted view, not the
  replaceable Host runtime key. Clear the previous conversation before routing
  events to a different selected session; keep it when only the runtime rebinds.
- Guard history reads against live updates. On WebUI's first successful load,
  merge the loaded history window with the live suffix once before reporting
  `ready`; preserve live message IDs, the active reply, and pending submissions.
  Match assistant overlap by message ID or a shared tool-call ID, not text or
  streaming status. Merge content around shared tools; if overlap is uncertain,
  keep both messages until reconciliation instead of dropping persisted content.
  Keep earlier pages lazy and reconcile the seam against the Host after the
  turn ends. Do not run the merge on each stream event. When a history window
  is already visible, defer an ordinary refresh that would overwrite live
  updates. A manual refresh interrupted by a new turn must clear its force flag
  and must not queue a retry.
- Manual history retry must omit the cached index fingerprint. The Host then
  stats the original Local/WSL/SSH JSONL before reusing a matching projection;
  passing a stale expected fingerprint can otherwise return the old cache.
- Desktop mounted controllers register their refresh callback with the workspace
  session actions and unregister on cleanup. Match rows by project and persisted
  Pi ID, not a draft controller ID. Unopened sessions warm a fresh source window
  without selecting the row. Refresh the project index after the request.
  Workspace actions probe external activity before calling mounted handlers;
  those handlers must not veto the fresh result with cached `externalRunning`
  props, since inactive controllers intentionally skip ordinary props updates.
- Replay replaces conversation/history-window state, not the controller or
  composer draft. Refresh live metadata/configuration only for an initialized
  running process, after applying historical metadata; never start, stop or
  restart Pi just to refresh. Desktop awaits this metadata refresh before
  publishing the new snapshot; WebUI uses its existing history/config reload.
- When verification is authorized, cover changed source with unchanged index,
  idle sessions with/without an existing Pi process, running/compacting/queued
  states, failed reads and retry, switching WebUI sessions during refresh,
  adopting a turn during the initial history read/replay, and refreshing a
  background external session after it becomes idle.

## Keep hooks focused

If a hook grows past one responsibility, split it — the chat feature does this
(`use-chat-runtime-queue`, `use-chat-runtime-events`,
`use-runtime-conversation-dispatch`).
