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

## Keep hooks focused

If a hook grows past one responsibility, split it — the chat feature does this
(`use-chat-runtime-queue`, `use-chat-runtime-events`,
`use-runtime-conversation-dispatch`).
