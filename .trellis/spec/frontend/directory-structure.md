# Frontend Directory Structure

> How the React app under `src/` is organized.

---

## Layout

```
src/
  main.tsx          # React root, providers, root error boundary
  App.tsx           # App shell: layout, panels, lazy feature mounting
  index.css         # Tailwind entry + design tokens
  ui/               # shadcn/ui-style primitives (barrel: ui/index.ts)
  components/       # feature components, one folder per feature
  lib/              # non-React logic, API clients, providers, hooks
  assets/
```

## `src/ui/`

Primitive, reusable building blocks (Button, Dialog, Select, Tooltip, …).
They are generic, prop-driven, and must not import feature code.

- Every primitive is re-exported from `src/ui/index.ts`. Import via
  `import { Button } from "@/ui"` — do not deep-import unless you need a
  non-barrel export.
- Add a new primitive here only if it is genuinely cross-feature.

## `src/components/<feature>/`

Feature UI lives in a kebab-case folder:

- `chat/` — the conversation surface (largest feature).
- `sidebar/` — project/session navigation.
- `settings/` — settings dialog sections.
- `app/` — app-shell orchestration hooks that wire features together.

Files are kebab-case, one component/hook per file, `export function Xxx`.
Co-located helpers (`chat-page-utils.ts`, `chat-expansion-state.tsx`) stay in
the feature folder.

## `src/lib/`

Non-React logic and thin glue, kebab-case files:

- **Tauri API clients**: one module per domain (`sessions.ts`, `connections.ts`,
  `projects.ts`, `terminal.ts`, `git.ts`, `preview.ts`, `parallel.ts`). These
  call `invoke`/`listen` and expose typed async functions. This is the only
  place `@tauri-apps/api` is used.
- **Pure logic**: `conversation-reducer.ts`, `chat-submission.ts`,
  `chat-virtualization.ts`, `skill-invocation.ts`, etc. — unit-tested in `tests/`.
- **Providers**: `preferences-provider.tsx`, `theme-provider.tsx`.
- **Cross-cutting hooks**: `use-keyboard-shortcut.ts`.

## Rules

- React code never calls `@tauri-apps/api` directly — go through `src/lib/*`.
- UI components don't contain raw Tauri calls; hooks/`lib` do.
- New feature → new folder under `components/`, new API module under `lib/` if
  it talks to the backend.
- Prefer `@/` path alias (maps to `src/`) over deep relative imports.
