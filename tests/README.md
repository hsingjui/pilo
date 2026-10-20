# Tests

Tests are grouped by execution environment, not by source-file location.
Use Node.js 22 (latest patch) and the existing `node:test` runner; no additional
JavaScript test framework is required.

```text
tests/
  unit/         # focused logic, state/store and React static-rendering tests
  integration/  # CLI/process and Pi extension integration tests
  browser/      # real-browser HTML regression pages
  packaging/    # Linux AppImage packaging/orchestration tests
  helpers/      # Node TSX transpilation and @/ alias resolution
```

## Node suites

Run from the repository root:

```bash
pnpm test                  # all Node unit + integration tests
pnpm test:unit             # unit suite only
pnpm test:integration      # integration suite only

# Run one file
node --experimental-strip-types --import ./tests/helpers/tsx-loader.mjs --test tests/unit/chat-mentions.test.ts

# Filter test names within one file (Node options must precede file paths)
node --experimental-strip-types --import ./tests/helpers/tsx-loader.mjs --test --test-name-pattern="round-trip" tests/unit/chat-mentions.test.ts
```

The scripts pass quoted recursive globs to Node so discovery does not depend
on shell wildcard expansion. Add `*.test.ts` or `*.test.mjs` files under the
appropriate directory; do not add individual filenames to `package.json`.

Unit tests cover focused modules, including stores and static React rendering.
Integration tests exercise scripts/processes and Pi extensions with local
stubs; they do not require a running desktop app or real SSH server. The SSH
workspace test uses a POSIX shell and filesystem permissions, so run the full
integration suite on Linux/WSL. Run desktop application verification on Windows
separately.

`tsx-loader.mjs` resolves `@/` against `src/` and transpiles TSX with the already
installed TypeScript dependency. Node strips ordinary TypeScript types. This
runner does not replace TypeScript type-checking.

## Browser regressions

```bash
pnpm exec vite --host 127.0.0.1
```

Open one of these paths at `http://127.0.0.1:1420`:

- `/tests/browser/cache-keep-alive.html`
- `/tests/browser/chat-run-config-cache.html` (project Scope default, manual-choice precedence, picker reload and live temporary-session configuration; check desktop and touch/mobile)
- `/tests/browser/chat-markdown-images.html`
- `/tests/browser/chat-markdown-links.html` (mocked system-opening IPC and remote/WebUI guards)
- `/tests/browser/project-workspace-tabs.html` (shared header file tabs, Markdown/code, retained chat state, project isolation, keyboard and narrow layouts)
- `/tests/browser/chat-mentions.html`
- `/tests/browser/chat-scroll-following.html`
- `/tests/browser/chat-streaming-status.html`
- `/tests/browser/chat-column-alignment.html` (message/composer edges, symmetric mobile margins, scrolling and desktop gutter; check 320/390/640/768/1023/1024/1440px)
- `/tests/browser/dom-text-selection.html`
- `/tests/browser/remote-mobile-navigation.html`

Each page reports results and sets `document.body.dataset.testStatus` to
`passed` or `failed`. These pages are not executed by `pnpm test`. Check both
desktop and narrow/mobile layouts where applicable. Selection behavior needs
Chromium and WebKit coverage; browser results do not replace Windows Tauri
WebView verification.

## Packaging and Rust

```bash
# Linux/WSL: fixture-based AppImage orchestration tests, not a real GUI/package run
pnpm test:packaging
# Equivalent direct command
python3 tests/packaging/test-linux-appimage.py

# Rust workspace tests (requires the platform's Tauri system dependencies)
cargo test --workspace --all-features
```

`pnpm test` does not include browser, packaging or Rust tests. `pnpm check`
checks formatting/lint only; `pnpm build` type-checks and builds the frontend.
