# Tests

Tests are grouped by execution environment, not by source-file location.
Use Node.js 22 (latest patch) and the existing `node:test` runner; no additional
JavaScript test framework is required.

```text
tests/
  unit/         # focused logic, state/store and React static-rendering tests
  integration/  # CLI/process and Pi extension integration tests
  browser/      # real-browser HTML regression pages
  helpers/      # Node TSX transpilation and @/, @shared/ alias resolution
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
integration suite on Linux/WSL. It reads the production Server extension and
simulates both Linux and macOS, redirecting all mux filesystem operations into
private fixture directories (never the real macOS `/tmp`). The nsh desktop
has its own suite: `cd desktop && nsh test`.

`tsx-loader.mjs` resolves `@/` against `web/` and `@shared/` against `shared/`, and transpiles TSX with the already
installed TypeScript dependency. Node strips ordinary TypeScript types. This
runner does not replace TypeScript type-checking.

## Browser regressions

```bash
pnpm exec vite --host 127.0.0.1
```

Open one of these paths at `http://127.0.0.1:1420`:

- `/tests/browser/cache-keep-alive.html`
- `/tests/browser/chat-markdown-images.html`
- `/tests/browser/chat-mentions.html`
- `/tests/browser/chat-scroll-following.html`
- `/tests/browser/chat-streaming-status.html`
- `/tests/browser/chat-column-alignment.html` (message/composer edges, symmetric mobile margins, scrolling and desktop gutter; check 320/390/640/768/1023/1024/1440px)
- `/tests/browser/dom-text-selection.html`
- `/tests/browser/remote-mobile-navigation.html`
- `/tests/browser/remote-session-isolation.html` (real WebUI with mocked Host/Pi; delayed history/RPC, rapid switching, late events, notification dedup/expiry, draft navigation, failed loads and global notices; check wide and touch/mobile viewports)

Each page reports results and sets `document.body.dataset.testStatus` to
`passed` or `failed`. These pages are not executed by `pnpm test`. Check both
desktop and narrow/mobile layouts where applicable. Selection behavior needs
Chromium and WebKit coverage.

## Rust

```bash
cargo test --workspace --all-features
cargo test --manifest-path desktop/Cargo.toml
```

`pnpm test` does not include browser, desktop or Rust tests. `pnpm check`
checks formatting/lint only; `pnpm build` type-checks and builds the frontend.
