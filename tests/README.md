# Tests

Tests are grouped by execution environment, not by source-file location.
Use Node.js 22+ with the built-in `node:test` runner for pure TypeScript and `pilo-server` integration tests, and `nsh test` for nsh Desktop & WebUI tests.

```text
app/tests/      # nsh headless & native UI tests (*.test.ts / *.test.tsx)
tests/
  unit/         # pure TS shared logic & script tests (*.spec.ts / *.spec.mjs)
  integration/  # CLI/process and Pi extension integration tests (*.spec.ts)
  helpers/      # Node @shared/* alias resolution
```

## Node suites

Run from the repository root:

```bash
pnpm test                  # all Node unit + integration tests
pnpm test:unit             # unit suite only
pnpm test:integration      # integration suite only

# Run one file
node --experimental-strip-types --import ./tests/helpers/tsx-loader.mjs --test tests/unit/chat-mentions.spec.ts
```

Node test files use `*.spec.ts` / `*.spec.mjs` so running `nsh test` directly at the repository root only discovers `app/tests/*.test.ts(x)`.

## nsh Desktop & WebUI

Run from the repository root. Native chat fixtures need the local `pilo-server`
and write synthetic sessions, so give the test run an isolated Pi directory.

```bash
nsh check
cargo build -p pilo-server
PI_CODING_AGENT_DIR="$PWD/target/nsh-test/pi-agent" \
PILO_SERVER_RUNTIME_DIR="$PWD/target/nsh-test/server" nsh test
```

On Windows (PowerShell):

```powershell
cargo build -p pilo-server
$env:PI_CODING_AGENT_DIR = Join-Path $PWD 'target/nsh-test/pi-agent'
$env:PILO_SERVER_RUNTIME_DIR = Join-Path $PWD 'target/nsh-test/server'
nsh test
```

If Cargo's output is redirected, set `PILO_SERVER_BINARY` to the absolute path
of the built server before running `nsh test`.

## Rust

```bash
cargo test --workspace --all-features
cargo test --manifest-path crates/pilo-desktop/Cargo.toml
```
