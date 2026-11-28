# Backend Quality Guidelines

> Rust review standards and validation commands.

---

## Validation Commands

Run from the repo root:

```bash
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

`clippy -D warnings` means a warning fails the check. Fix warnings, don't silence
them (`#[allow(...)]` only with a comment explaining why).

Enable the versioned `.githooks/pre-commit` hook once per clone with
`pnpm hooks:install`. It runs `pnpm check` (frontend format/lint), then
`cargo fmt --all --check` (Rust formatting). TypeScript type checking, Rust
workspace check and Clippy stay outside the hook to keep commits fast; CI's
checks are unchanged, including TypeScript checking through `pnpm build`. Full
frontend builds and tests also stay outside the hook. Any nonzero exit blocks
the commit. The hook checks the working tree without formatting or staging
files; keep its executable bit and LF line endings for Git on Windows.
Use only POSIX `sh` syntax: Windows uses Git for Windows' bundled shell, while
macOS/Linux use the system shell. Both pnpm and Cargo must be on the committing
process's `PATH`, and project Node.js dependencies must be installed. Hook
configuration is local to each checkout, not copied by source sync.
These checks cover the current host only; WSL cannot validate native Windows
or macOS code paths.

## Code Standards

- **Edition 2024**, `resolver = "2"` workspace.
- Prefer `pub(crate)` over `pub` except for types and operations used by another crate.
- Host operations take `&Runtime`; storage takes `&HostPaths`. A synchronous
  SQLite operation stays synchronous in the runtime; the nsh bridge calls it
  via `Pilo::with_runtime_blocking` to avoid blocking the UI or async executor.
- Process/IO work is `tokio`-based (`fs`, `io-util`, `process`, `sync`, `time`).
- Serde types exposed to the frontend use `#[serde(rename_all = "camelCase")]`
  (see `crates/pilo-runtime/src/session_history/types.rs`). Wire fields that must
  keep their name use an explicit `#[serde(rename = "...")]`.
- Keep `pilo-domain` types plain data; no `Mutex`, no side effects.

## Testing

- Unit tests live inline under `#[cfg(test)] mod tests` in the module they cover
  (e.g. `storage.rs`, `session_history/tests.rs`, `pilo-server/src/tests.rs`).
- Integration tests: `crates/pilo-server/tests/stdio_protocol.rs`.
- Pure logic tests: `#[test]`; anything touching async runtime: `#[tokio::test]`.
- Storage tests use in-memory SQLite, never the real app DB.
- Prefer small focused tests over broad integration suites.

## Forbidden Patterns

- `.unwrap()` / `.expect()` outside tests and truly infallible cases.
- `unsafe`.
- String interpolation into SQL.
- Adding `anyhow`/`tracing`/new dependencies just for ergonomics — the stack is
  deliberately small.
- Panicking at a native or HTTP request boundary.
- Blocking the async runtime with synchronous long-running work; use
  `spawn_blocking` / a background thread.

## Viewer Absolute File Reads

### 1. Scope / Trigger

Desktop tool-path clicks may preview files outside the project, including Skills.
Only read-only viewer access expands; WebUI gets no generic filesystem route.

### 2. Signatures

- `project_fs_read_file(id: String, path: String) -> Result<Vec<u8>, String>`
  delegates to `remote_fs::read_viewer_file(servers, project, path)`.
- Internal `remote_fs::read_file` remains project-contained, including its use
  by `read_image`.

### 3. Contracts

Relative paths use the original project root. Absolute POSIX, Windows drive and
UNC paths use the selected file's parent as the server request root and its name
as the relative path. Resolve through the project's connection, never the desktop
host's filesystem parser for WSL/SSH. The temporary root never updates storage.
Workspace file identity preserves absolute paths (including drive/UNC paths);
only relative paths are joined to the project directory.

### 4. Validation & Error Matrix

The existing server canonicalization, parent containment, symlink-escape checks,
binary transport limits and viewer text/size checks still apply. Server file reads
require regular files before opening, rejecting directories, devices and FIFOs.
Read at most `MAX_BINARY_PAYLOAD_BYTES + 1` bytes and reject an oversized result
even if the file grows after metadata inspection; metadata length alone is not
a read bound. Missing files and unreadable parents propagate normal viewer errors.
Writes, deletes, directory listings and Markdown image reads keep their project scope.

### 5. Good / Base / Bad Cases

Good: an SSH Skill absolute path is read on SSH. Base: project-relative file
previews are unchanged. Bad: interpreting a WSL path with Windows host APIs.

### 6. Tests Required

Pending explicit authorization: relative/internal/external absolute files,
POSIX root-level files, Windows drive roots and UNC shares, Unicode/spaces,
missing or unreadable files, symlink escapes, size/binary rejection and project
switches. Reject directories, devices (including `/dev/zero`) and FIFOs without
reading them; reject files that grow past the limit during reading. Absolute
workspace paths must retain editor targets and deduplicate with file-link tabs.
Confirm WebUI still has no generic file-read endpoint and mutations remain
project-contained.

### 7. Wrong vs Correct

Wrong: permit absolute paths in the shared server filesystem validator.
Correct: select a temporary read-only viewer root and reuse server validation.

## Platform Notes

- macOS/Windows-only code is gated with `#[cfg(target_os = ...)]` and
  platform dependencies live under `[target.'cfg(...)'.dependencies]` in
  each crate's `Cargo.toml`.
- macOS is the current desktop target. See the [desktop validation rules](../desktop/quality-guidelines.md) for native checks and deferred packaging/platform work.

### Bundled server resource paths

- `desktop/src/pilo/mod.rs` initializes `HostPaths` and supplies the application
  resources directory to `initialize_server_resource_dir` before starting the Host.
- For WSL/SSH, `server_binary` checks `PILO_SERVER_PATH` and the applicable
  `PILO_SERVER_LINUX_PATH` first. Debug builds use Cargo debug output; they never
  fall back to release resources. Release builds look in `<resource_dir>/runtime`,
  adjacent `runtime`, macOS `../Resources/runtime`, and staged `resources/`.
- `server-runtimes.yml` builds and verifies the bundled server set independently
  of the desktop. The deleted Tauri packaging rules are historical; do not treat
  them as nsh packaging instructions.

### Manual development runtime builds

#### 1. Scope / Trigger

Dev startup, manual server/extension builds and deployment isolation.

#### 2. Signatures

- `pnpm dev` builds `pilo-server` and `pilo-cli` in one native Cargo invocation
  before starting the WebUI build and desktop Host. `PILO_SERVER_BINARY` and
  `PILO_CLI_BINARY` each skip only the corresponding build. WebUI rebuilds and
  `pnpm dev:web` do not invoke Cargo.
- Use the `compiler-artifact.executable` paths from this Cargo invocation for
  `PILO_SERVER_BINARY` and `PILO_CLI_BINARY` when not already overridden. This
  respects `CARGO_TARGET_DIR` and `build.target-dir`, including cached artifacts.
  On Windows, copy that CLI artifact to `target/debug/pilo-cli-bin/pilo-dev.exe`
  and pass the staged path via `PILO_CLI_BINARY`. The installer adds that
  directory to PATH on request; never point it at the shared `target/debug`.
- `pnpm server:build [target]` runs `scripts/build-server.mjs` for manual
  WSL/SSH development builds. There is no separate `:dev` command.
- Release CI still calls `bash scripts/build-pilo-server.sh [target]` without
  `--dev` and stages production resources; do not replace it with the dev entry.
- `bash scripts/build-pilo-server.sh --dev [target]` builds a debug runtime in
  `target/<rust-target>/debug/`, without a staging copy.
- `PILO_DEV_WSL_DISTRO` optionally selects the Windows build distro.
- Dev defaults: `CARGO_BUILD_JOBS=1`, `CARGO_PROFILE_DEV_DEBUG=0`; callers may
  override them. Production build settings remain unchanged.

#### 3. Contracts

- Dev startup never builds WSL/SSH runtimes or watches plugins specially.
- Local debug uses a standalone `pilo-server`, normally built with
  `cargo build -p pilo-server`. WSL/SSH debug loads manually
  built binaries from `target/<rust-target>/debug/pilo-server` (Windows: `.exe`),
  never production fallback.
- Windows manual builds run through WSL against the Windows checkout; POSIX builds
  run directly. Default to the build environment's native target. Cross-target
  builds need the target toolchain/linker. Use the workspace’s normal `target/`
  directory for Cargo output, with no `target/pilo-dev` build or staging tree.
  Dev server builds neither copy binaries to resources nor deploy running environments.
- Plugins are embedded in server binaries. Startup deploys them into the runtime
  root's `extensions/`; rebuild and restart Pilo/Pi after changes. No reload
  markers or custom backend watcher. Reject release/custom dev profiles to
  prevent accidental production runtime paths.
- Debug Local cache is `LOCALAPPDATA/pilo-dev/server` or POSIX `pilo-dev/server`;
  WSL/SSH explicitly use `$HOME/.cache/pilo-dev/server`. Do not remove production
  legacy directories during debug deployment. Pi config/session files are shared.
- Debug deployments re-read artifact fingerprints after manual builds. Existing
  deployment fingerprint checks upload changed binaries on the next connection.
  Never automatically resend prompts or restart an active Pi process for a build.
- Source sync to Windows excludes production server resources and all build
  output. Run the manual dev build in the Windows checkout after source sync.

#### 4. Validation / Error Matrix

- Local startup build failure: propagate nonzero exit; do not start the Host.
  A successful build with no requested executable in its artifact stream also
  fails startup; do not fall back to a potentially stale binary.
- Manual build failure: propagate nonzero exit; do not deploy or restart Pi.
- Missing remote debug target: explicit error directing users to `pnpm server:build`.
- No WSL on Windows: manual remote build fails; Local still builds natively.

#### 5. Good / Base / Bad Cases

- Good: rebuild after a plugin edit; restart and deploy only dev resources.
- Base: Local dev runs its standalone debug server.
- Bad: dev startup forces a cold WSL build, or shares production runtime paths.

#### 6. Tests Required

Pending explicit authorization: standard and custom Cargo output paths, Windows
CLI staging from the reported artifact, build failure propagation, Windows WSL
paths, missing target errors, plugin deployment on Local/WSL/SSH,
production/dev coexistence and source sync isolation.
`current_platform_resolves_its_server_runtime` checks the Cargo filename in
Debug, or the exact missing-dev-runtime error when no standalone dev build
exists. Local requires its standalone binary as well. Release still requires
an existing binary with the packaged resource filename. Syntax and lint checks
are not end-to-end runtime validation.

#### 7. Wrong vs Correct

Wrong: dev startup automatically builds remote servers, or dev binaries overwrite
`resources/`. Correct: `pnpm dev` builds only the local server; remote builds are
explicit and deployment uses isolated runtime roots.

### Release server runtime set cache

#### 1. Scope / Trigger

`server-runtimes.yml` runs on `main`, can be dispatched manually, and can be
called by another workflow. The desktop `release.yml` calls it after version
validation and downloads its artifact from the same run.
Check the complete binary set on Ubuntu before scheduling native build runners;
Cargo dependency caches alone cannot avoid macOS runner queue time.

#### 2. Signatures

- `prepare` exports `cache-hit`, `cache-key`, and the resolved stable `toolchain`.
- The cache key is `pilo-server-runtimes-v1-<sha256>`, hashing `rustc --version`
  and `git ls-tree -r HEAD` entries for workspace/domain/runtime manifests, `Cargo.lock`,
  `.cargo`, Rust toolchain files, both server/protocol crates (including embedded
  extensions), the build/verification scripts, and the runtime workflow itself.
- The consumer interface remains the `pilo-server-runtimes` artifact containing
  all four files required by `scripts/verify-pilo-server-resources.sh`.

#### 3. Contracts

- Only `cache-hit == 'true'` permits reuse. Do not configure prefix restore keys.
- An exact hit verifies and uploads the set in `prepare`; `build` and `bundle`
  skip, so no Windows/macOS runtime runner is requested.
- A miss builds all targets with the exact Rust release resolved by `prepare`.
  Release server builds use `--locked`; debug/manual dev behavior is unchanged.
  `bundle` verifies and uploads the complete set before saving the cache.
- Save and restore the same path on Ubuntu. Main builds seed the default-branch
  cache, which tags can restore; different tags cannot share tag-only caches.
- Keep main push path filters aligned with the hashed inputs. A version bump
  invalidates the set because the server embeds `CARGO_PKG_VERSION`. Main must
  finish seeding the matching cache before a release can reuse it.

#### 4. Validation & Error Matrix

- Missing/evicted cache or changed inputs: rebuild; never use the latest unrelated
  artifact or a partial cache match.
- Exact cache hit missing a required nonempty file: fail verification.
- Build, lockfile, or set verification failure: do not save or consume that set.
- Cache save unavailable: the verified uploaded artifact remains usable for the
  current run; later runs may rebuild.

#### 5. Good / Base / Bad Cases

- Good: frontend-only changes reuse the same complete runtime set from main.
- Base: first run or changed extension/version/Rust release builds all targets.
- Bad: reuse a previous version's server or schedule macOS just to check a cache.

#### 6. Tests Required

Pending explicit authorization: CI cold miss/hit runs must confirm four target
builds versus zero native runtime jobs, identical artifact filenames, unchanged
release download behavior, and invalidation on embedded extension, version,
lockfile, toolchain and build-input path changes. Do not infer measured speedup
from workflow edits without a real Actions run.

#### 7. Wrong vs Correct

Wrong: download the most recent successful server build regardless of inputs.
Correct: exact input-keyed set reuse, with normal builds on a miss and required
file verification before handing the artifact to desktop packaging.

### Pi executable discovery

#### 1. Scope / Trigger

`crates/pilo-server/src/environment.rs` owns Pi discovery for Local/WSL/SSH.
Desktop and WebUI use the same server path; do not implement browser-side or
shell-only executable discovery.

#### 2. Signatures

- `resolve_pi_executable(state, requested) -> Result<(String, String), String>`
  returns the executable and its runtime `PATH`.
- `environment.pi_probe { executable?: string }` validates that executable with
  `--version`; `pi.start { piExecutable?: string, ... }` uses the same resolver.
  Neither wire schema changes.

#### 3. Contracts

- Explicit executable overrides automatic discovery. A broken default Pi must
  not prevent starting a valid explicit executable or inspecting a project whose
  Pi runtime is local rather than in the connection environment.
- Preserve shell/inherited `PATH` priority, then append environment-configured
  and common global bin directories. Include npm prefixes, `PNPM_HOME` (root and
  `bin` layouts), `BUN_INSTALL/bin`, and managed Pi's `.pi/agent/bin` or
  `PI_CODING_AGENT_DIR/bin`. Keep the official installer's standalone Node path:
  `XDG_DATA_HOME/pi-node/current/bin` (default `.local/share/pi-node/current/bin`)
  or Windows `LOCALAPPDATA/pi-node/current`.
- Windows supplements inherited `PATH` from persisted user/machine environment
  using a hidden, noninteractive, profile-free PowerShell process. Resolve
  percent-variable references in that child only; never write the registry or
  mutate the server's process environment.
- Windows also appends mise shims from `MISE_DATA_DIR/shims` when configured
  and `LOCALAPPDATA/mise/shims`, after inherited/persisted `PATH`. Finding
  `pi.cmd` is insufficient when its Node is managed by mise; both probing and
  RPC startup must receive the augmented path. Do not pick a hardcoded Node
  version directory or change the user's system `PATH`.
- Windows CLI probes run through hidden, noninteractive, profile-free PowerShell
  with UTF-8 console/output encoding, preserving the native exit code and the
  existing timeout. Quote executable/arguments as PowerShell string literals
  (double embedded single quotes); never interpolate them as shell syntax.
  This makes `cmd` shim diagnostics valid UTF-8 before `command_output_text`
  decodes them. Actual Pi RPC startup remains a direct process invocation.
- If no Pi is found, refresh the shell/persisted path and query available package
  managers in parallel: `npm prefix -g`, `pnpm bin -g`, `bun pm bin -g`. Only npm
  needs `/bin` appended on Unix. Probes run from the user's home when available,
  disable Corepack downloads, and do not install Pi or a package manager.
- Retain the full runtime `PATH` from successful fallback discovery in the shared
  login-path cache, including refreshed shell paths and package-manager bins. A
  later explicit-path probe/start must reuse it after settings save the detected
  executable; adding only Pi's parent loses Node in a separate install directory.
- Do not cache Pi selection, version, or a missing-Pi result in `ToolchainInfo`.
  Keep absent fallback directories in `PATH` so a later install can be found.
- Unix candidates must be files with execute bits. Windows discovery accepts
  native/batch extensions, preserves supported `PATHEXT` order, and never
  automatically selects an extensionless shell script or a `.ps1` shim.

#### 4. Validation & Error Matrix

- Shell/persisted-path probe: five-second timeout; preserve inherited path on
  failure. Individual CLI probes: eight-second timeout.
- Missing/broken package manager: ignore its optional directory query, allowing
  the others to succeed. Missing Pi: preserve the `Pi executable` / `not found
  in PATH` error signals and suggest an explicit executable path.
- Found Pi with a failing `--version`: report that failure, not a fake version
  or an automatic switch to a different installed Pi.

#### 5. Good / Base / Bad Cases

- Good: managed Pi outside inherited `PATH` starts with its standalone Node;
  custom npm/pnpm/bun global bins are discovered without hardcoded package names.
- Base: Pi already on the selected environment's `PATH` keeps priority.
- Bad: the probe finds Pi in an augmented path but RPC starts with the old path.

#### 6. Tests Required

Pending explicit authorization: npm/pnpm/bun default and custom global bins;
Windows `.cmd`/`.exe` versus extensionless shims, explicit `pi.cmd`, Unicode and
space-containing paths, persisted `%PNPM_HOME%`, managed Pi plus standalone Node,
Unix execute permissions, post-install retry, explicit override with a broken
default, and probe/start path parity. Cover installing Node and Pi in separate
custom directories after server startup, then auto-probing, saving the detected
absolute executable, and starting RPC with the refreshed Node path still present.
Also cover Windows mise-managed Node with only `pi.cmd` on the original path,
custom `MISE_DATA_DIR`, existing Node path priority, native nonzero exit codes,
Chinese diagnostics, and executable/argument paths containing spaces or quotes.
No automated or native-runtime validation is implied by source review or formatting.

#### 7. Wrong vs Correct

Wrong: cache a missing Pi forever, assume every global executable lives in
npm's default directory, or invoke a guessed package-internal CLI file.
Correct: resolve the public Pi executable in its own environment, carry its
runtime path into RPC startup, and retain explicit-path configuration as fallback.
