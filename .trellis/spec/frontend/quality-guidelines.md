# Frontend Quality Guidelines

> Linting, formatting, testing, and review standards.

---

## Validation Commands

```bash
pnpm format        # oxfmt --write  (apply formatting)
pnpm check         # oxfmt --check + oxlint (CI gate)
pnpm build         # tsc && vite build
pnpm test          # Node unit + integration suites (not browser/packaging/Rust)
pnpm test:unit     # tests/unit/**/*.test.{ts,mjs}
pnpm test:integration # tests/integration/**/*.test.{ts,mjs}
pnpm test:packaging # Python AppImage orchestration tests (Linux/WSL)
```

Run `pnpm format`, `pnpm check`, `pnpm build` for any frontend change. Full
desktop verification (`pnpm tauri dev`) runs on Windows.

## Formatting (oxfmt)

Config `.oxfmtrc.json`: `useTabs: true`, `tabWidth: 2`, `printWidth: 80`,
`singleQuote: false`, `semi: true`, `trailingComma: "all"`, `arrowParens: "always"`.
Do not hand-format — run `pnpm format`.

`ignorePatterns` excludes tool-generated trees that are not ours to format:
`.pi/**` and `.trellis/**`. Trellis scripts write `task.json` with
`json.dumps(indent=2)`, which conflicts with `useTabs: true`; without the
ignore, every `task.py archive` breaks the CI format gate.

## Linting (oxlint)

`.oxlintrc.json` enables `typescript`, `unicorn`, `oxc`, `react`, `jsx-a11y`
with `correctness: error`, `suspicious: warn`, `perf: warn`. CI runs with
`--deny-warnings`, so warnings fail. `react/react-in-jsx-scope` is off (React 19
automatic JSX).

## Testing

- Runner: Node 22's built-in `node --test` with `--experimental-strip-types`.
  No Jest/Vitest or new framework dependency. `tests/helpers/tsx-loader.mjs`
  handles TSX and `@/` aliases.
- Location: `tests/unit/<name>.test.ts` for focused tests;
  `tests/integration/<name>.test.{ts,mjs}` for CLI/process/extension integration.
  Import source directly using paths relative to the test file.
- Assertions: `node:assert/strict`.
- Unit scope: reducers, parsers, state machines, formatting, stores and focused
  React static-rendering checks. Real DOM/interaction checks live in
  `tests/browser/`; packaging checks live in `tests/packaging/`.
- Scripts use quoted recursive globs expanded by Node, not a shell-specific
  file list. New matching files are included automatically. `pnpm test` runs
  both Node suites; browser, packaging and Rust tests are separate.
- See `tests/README.md` for commands and platform requirements.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillInvocation } from "../../shared/chat/skill-invocation.ts";

test("parses the expanded skill block emitted by Pi", () => {
	assert.deepEqual(parseSkillInvocation(expandedText), { ... });
});
```

- A new pure module in `shared/` that encodes non-trivial logic should ship
  with a matching `tests/unit/*.test.ts`; no `package.json` file-list change
  is needed.
- Static rendering does not verify browser interactions or hooks. Use the
  browser regression pages and manual desktop runs for those behaviors.

### Browser Selection Regression

`web/lib/dom-text-selection.ts` handles unmodified left-button triple-click
`mousedown` and `mouseup` for prose in the shared desktop/WebUI bootstrap.
Schedule tightening with `requestAnimationFrame`: the native `mousedown` default
must establish its paragraph range first, but normalization must happen before
paint, not only after mouse release (which causes a visible flash). Keep
`mouseup` as the final pass for triple-click drag. Preserve the native paragraph
range and selection direction; tighten only its outer text endpoints.
Do not select the entire `li` or `td`: nested lists and multi-paragraph cells
must retain native paragraph scope. Inputs, editable content, code blocks,
buttons, terminals, ordinary drag selection and touch long-press stay native.

DOM selection tests need a real browser, not mocked `Range`/`Selection` objects.
Run `pnpm exec vite --host 127.0.0.1`, open
`/tests/browser/dom-text-selection.html`, and require
`data-test-status="passed"` on the body. This suite is separate from `test:unit`.
Verify both Chromium and WebKit:
WebKit can clamp selections at editing boundaries, so native-control tests
compare the actual range before/after rather than assuming requested endpoints.
Selection assertions do not replace visual verification in the desktop WebView.

## Review Standards

- No unrelated refactors or formatting churn in a feature change.
- Preserve type safety (see `type-safety.md`) and accessibility (`jsx-a11y`).
- Reuse `web/ui` primitives and `web/lib` helpers before writing new ones.
- Keep Tauri access in `shared/*`; components stay declarative.
- Built-in user-facing copy supports `zh-CN` and `en-US` through the i18n layer
  (`web/i18n`); code identifiers stay English (see "Internationalization").

## Internationalization (i18n)

- Bundled resources live in `shared/i18n/resources/{en-US,zh-CN}.ts`. English is the
  schema/source; `shared/@types/i18next.d.ts` type-checks keys (strictKeyChecks).
- Add new built-in copy through `t("semantic.key")` in both resources. Never
  hard-code one language in components.
- Translate at the presentation boundary. Static registries keep stable IDs
  (e.g. shortcut command IDs), and pure logic returns semantic states/codes,
  not localized strings.
- Use `useTranslation()` in components/hooks. Non-React adapters may call the
  initialized `i18n` instance.
- Pass the active `i18n.language` explicitly to `Intl`/`toLocaleString` when
  formatting should follow Pilo's language, not the OS locale.
- Do not translate user/Agent content, file paths, Git data, terminal output,
  raw backend error details, protocol IDs, or persisted domain values.

## Forbidden

- Adding test/lint/build dependencies (Jest, Vitest, ESLint, Prettier) — the
  toolchain is oxfmt + oxlint + node:test and is intentional.
- `console.log` left in shipped code (debug helpers are opt-in and namespaced,
  e.g. `installChatPerformanceDebugApi`).
- Committing without running `pnpm check`.
