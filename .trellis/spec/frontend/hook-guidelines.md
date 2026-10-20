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
  load time; normal live appends or a newly advanced index are not failures.
  Desktop read failures expose the normalized backend detail alongside the
  existing error view/retry button; WebUI retains its fatal-error notice.
- When verification is authorized, cover stale index A returning history B
  (one load, stable messages, visible notice), unchanged failure after a prior
  success (no automatic retry), manual retry, index catch-up (notice clears),
  later index changes (reload allowed), and live-turn notice suppression.

## Manual Session Refresh

- Desktop and WebUI expose refresh in each left-sidebar session row menu,
  including the mobile navigation drawer, not in the top-right session header.
  The row uses `useSessionRefresh` for pending state and localized errors. Disable
  running rows; reject requests while compaction, retry, submission, an extension
  dialog or history load is active. Running sessions do not queue a
  refresh for later. Recheck Host runtime activity and Pi streaming/compaction
  before requesting history, since the menu state can lag behind the process.
- If a turn is adopted while an ordinary history read/replay is pending, mark
  that load deferred so it retries after the turn ends. Returning `ready` without
  publishing a snapshot or marking it deferred can strand the initial history.
  A manual refresh interrupted by a new turn must clear its force flag and must
  not queue a retry.
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
