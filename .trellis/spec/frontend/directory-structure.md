# Frontend Directory Structure

> How the React WebUI under `web/` and the shared TypeScript under `shared/` are organized.

---

## Layout

```
web/
  main.tsx          # React root, providers, root error boundary; renders the WebUI
  index.css         # Tailwind entry + design tokens
  ui/               # shadcn/ui-style primitives (barrel: ui/index.ts)
  components/       # feature components, one folder per feature
  lib/              # React-side logic, API helpers, providers, hooks
  remote/           # WebUI shell (browser transport, pairing, mobile navigation)
  styles/           # theme CSS (also the input of the desktop theme generator)
  assets/
shared/             # plain TypeScript used by web/ and desktop/ (`@shared/*`)
```

`web/` imports its own modules as `@/…` and shared ones as `@shared/…`. `shared/`
must stay free of React, the DOM and nsh: `tsc -p shared` (part of `pnpm build`)
and the oxlint `no-restricted-imports` override enforce it. Move a module into
`shared/` once the desktop needs it; keep React hooks and components in `web/`.

## `web/ui/`

Primitive, reusable building blocks (Button, Dialog, Select, Tooltip, …).
They are generic, prop-driven, and must not import feature code.

- Every primitive is re-exported from `web/ui/index.ts`. Import via
  `import { Button } from "@/ui"` — do not deep-import unless you need a
  non-barrel export.
- Add a new primitive here only if it is genuinely cross-feature.

## `web/components/<feature>/`

Feature UI lives in a kebab-case folder:

- `chat/` — the conversation surface (largest feature).
- `sidebar/` — project/session navigation.
- `settings/` — settings dialog sections.
- `app/` — app-shell orchestration hooks that wire features together.

Files are kebab-case, one component/hook per file, `export function Xxx`.
Co-located helpers (`chat-page-utils.ts`, `chat-expansion-state.tsx`) stay in
the feature folder.

## `web/lib/` and `shared/`

`web/lib/` holds React-side logic: providers, hooks, WebUI API helpers.
`shared/` holds plain TypeScript both apps import, with the same kebab-case layout:

```text
shared/
  api/       # PiloClient interface and runtime transport/types
  chat/      # conversation state, replay, submissions, mentions, markdown helpers
  i18n/      # typed message lookup and bundled locale resources
  sidebar/   # sidebar session types and list ordering
  *.ts       # cross-feature models (settings, themes, shortcuts, formatting)
```

- **Transport-neutral client**: `shared/api/pilo-client.ts` defines `PiloClient`;
  `web/remote/web-pilo-client.ts` implements it over fetch/WebSocket and
  `desktop/client/nsh-pilo-client.ts` over the native module. Feature code
  depends on `PiloClient`, not on an implementation.
- **Remote transport**: `web/remote/remote-client.ts` holds Remote HTTP/WS calls
  and token storage; `web/remote/remote-app.tsx` is the browser shell.
- Component-specific helpers stay beside their components instead of moving
  into `lib/` just because they are testable.
- Import modules directly; do not add compatibility re-export files or a new
  barrel solely to hide a directory move.

## `tests/`

- `unit/`: focused logic, state/store and static-rendering tests.
- `integration/`: CLI/process and Pi extension integration tests.
- `browser/`: HTML regression pages served through Vite.
- `helpers/`: shared test tooling, including the Node TSX/alias loader.

See `tests/README.md` for commands. New Node tests are discovered by directory
and file name; do not maintain a per-file list in `package.json`.

## Rules

- New feature → new folder under `web/components/`; logic the desktop also
  needs goes to `shared/`.
- Prefer the `@/` (→ `web/`) and `@shared/` aliases over deep relative imports.
