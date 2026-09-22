# Frontend Quality Guidelines

> Linting, formatting, testing, and review standards.

---

## Validation Commands

```bash
pnpm format        # oxfmt --write  (apply formatting)
pnpm check         # oxfmt --check + oxlint (CI gate)
pnpm build         # tsc && vite build
pnpm test:unit     # node --test on tests/*.test.ts
```

Run `pnpm format`, `pnpm check`, `pnpm build` for any frontend change. Full
desktop verification (`pnpm tauri dev`) runs on Windows.

## Formatting (oxfmt)

Config `.oxfmtrc.json`: `useTabs: true`, `tabWidth: 2`, `printWidth: 80`,
`singleQuote: false`, `semi: true`, `trailingComma: "all"`, `arrowParens: "always"`.
Do not hand-format — run `pnpm format`.

## Linting (oxlint)

`.oxlintrc.json` enables `typescript`, `unicorn`, `oxc`, `react`, `jsx-a11y`
with `correctness: error`, `suspicious: warn`, `perf: warn`. CI runs with
`--deny-warnings`, so warnings fail. `react/react-in-jsx-scope` is off (React 19
automatic JSX).

## Testing

- Runner: Node's built-in `node --test` with `node --experimental-strip-types`.
  No Jest/Vitest, no framework, no fixtures.
- Location: `tests/<name>.test.ts`, importing source directly from `../src/lib/<name>.ts`.
- Assertions: `node:assert/strict`.
- Scope: **pure logic** — reducers, parsers, state machines, formatting.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillInvocation } from "../src/lib/skill-invocation.ts";

test("parses the expanded skill block emitted by Pi", () => {
	assert.deepEqual(parseSkillInvocation(expandedText), { ... });
});
```

- A new pure module in `src/lib/` that encodes non-trivial logic should ship with
  a matching `tests/*.test.ts`, and the file must be added to the explicit list
  in the `test:unit` script in `package.json`.
- React components/hooks are not unit-tested here; verify them via `pnpm build`
  and manual desktop runs.

## Review Standards

- No unrelated refactors or formatting churn in a feature change.
- Preserve type safety (see `type-safety.md`) and accessibility (`jsx-a11y`).
- Reuse `src/ui` primitives and `src/lib` helpers before writing new ones.
- Keep Tauri access in `src/lib/*`; components stay declarative.
- User-facing copy is Simplified Chinese; code identifiers English.

## Forbidden

- Adding test/lint/build dependencies (Jest, Vitest, ESLint, Prettier) — the
  toolchain is oxfmt + oxlint + node:test and is intentional.
- `console.log` left in shipped code (debug helpers are opt-in and namespaced,
  e.g. `installChatPerformanceDebugApi`).
- Committing without running `pnpm check`.
