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

## Code Standards

- **Edition 2024**, `resolver = "2"` workspace.
- Prefer `pub(crate)` over `pub`. Only `domain/*` and command functions need
  wider visibility.
- Async commands use `#[tauri::command] pub async fn`; sync ones stay sync.
  Don't make a command async if it only touches SQLite.
- Use `State<'_, PiloRuntime>` for shared runtime access;
  `AppHandle` for storage/app-dir access.
- Process/IO work is `tokio`-based (`fs`, `io-util`, `process`, `sync`, `time`).
- Serde types exposed to the frontend use `#[serde(rename_all = "camelCase")]`
  (see `src-tauri/src/runtime/session_history/types.rs`). Wire fields that must
  keep their name use an explicit `#[serde(rename = "...")]`.
- Keep `domain/` types plain data; no `Mutex`, no side effects.

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
- Panicking in a `#[tauri::command]` (poisons the IPC response).
- Blocking the async runtime with synchronous long-running work; use
  `spawn_blocking` / a background thread.

## Platform Notes

- macOS/Windows-only code is gated with `#[cfg(target_os = ...)]` and
  platform dependencies live under `[target.'cfg(...)'.dependencies]` in
  `src-tauri/Cargo.toml`.
- `pnpm tauri dev` and desktop-window/installer verification must run on Windows.
  WSL is for code, `cargo check`, and static validation only.

### Linux Wayland window decorations

- Keep the desktop Tauri dependency at `2.12` or newer and commit `Cargo.lock`.
  `cargo tree --locked -i tao` must resolve Tao >= 0.36.0; older Tao forces GTK
  client-side decorations even when KWin supports server-side decorations.
- When upgrading the Rust `tauri` minor version, update the direct
  `@tauri-apps/api` dependency and `pnpm-lock.yaml` to the same major/minor.
  `pnpm build` does not run the Tauri packaging version check; verify the
  installed API version against `Cargo.lock` before packaging.
- Keep `app.windows[].decorations: true` in `src-tauri/tauri.conf.json`.
  The Windows-only builder override in `desktop_window.rs` intentionally disables
  decorations for its custom title bar; do not extend that override to Linux.
- Do not use `GTK_CSD=0`, force X11, or install a custom GTK HeaderBar as a fix.
  The upstream fix is https://tauri.app/release/tao/v0.36.0/.
- After rebuilding, manually verify KDE title bar buttons and native Wayland
  scaling on KWin. Static compilation cannot verify compositor behavior.
- On Linux, initialize GLib's program name from the configured product name
  before creating the Tauri runtime. GDK uses it as the Wayland `app_id` when
  GTK application registration is disabled; it must match the case-sensitive
  desktop entry basename (`Pilo` for `Pilo.desktop`), not `Icon=pilo` or the
  executable name. This also covers secondary windows.
- Keep `enableGTKAppId` disabled: enabling it registers on D-Bus and changes
  multi-instance behavior. Do not change AppImage finalization just to fix the
  installed deb/rpm window icon. Development builds use `Pilo Dev` and need a
  matching desktop entry for compositor-provided icons.

### Bundled server resource paths

- Initialize the server resource directory from `app.path().resource_dir()` in
  Tauri setup, before restoring connections or starting server prewarming.
- `server_binary` checks explicit `PILO_SERVER_PATH` / `PILO_SERVER_LINUX_PATH`
  overrides first. Debug builds then require the standard Cargo output
  `target/<rust-target>/debug/pilo-server` (`pilo-server.exe` on Windows) and never
  fall back to production resources. Release builds check
  `<resource_dir>/runtime/<resource_name>`, portable/macOS fallback locations,
  and staged production resources. Missing release files keep the existing
  `bundled pilo-server runtime ... is missing` error.
- Linux resource directories use Tauri's product name, not the executable stem:
  the deb installs `/usr/bin/pilo` with resources under `/usr/lib/Pilo/runtime`.
  AppImage resources live under its mount directory. Do not lowercase the
  product name or infer `/usr/lib/pilo` from the executable.
- Regression coverage must include the case-sensitive deb/rpm layout and the
  AppImage mount layout, alongside Windows portable and macOS bundle paths.

### Linux AppImage finalization

- Desktop metadata lives in `bundle.category`, `shortDescription`,
  `longDescription`, and `homepage`. deb and rpm share
  `src-tauri/linux/pilo.desktop`; AppImage inherits the deb desktop template.
  Use a `.desktop` extension: oxfmt treats `.hbs` as HTML and destroys the
  required line-based desktop entry syntax.
  Keep `Exec`, `Icon`, `Name`, and categories as Tauri template variables, retain
  optional MIME associations, and validate the rendered desktop entry with
  `desktop-file-validate`. Localized comments and search keywords belong in the
  shared template, not in separate package-specific copies.
- Align package and desktop descriptions with the English/Chinese README
  introduction. Application versions inherit `[workspace.package].version`;
  the optional desktop entry `Version` describes the file format, not Pilo's
  release version, and must not be bumped with app releases.

- Run `scripts/finalize-linux-appimage.sh <AppImage> <AppDir> <runtime-dir>
  <AppImage-output-plugin>` after Tauri bundling and before collecting assets.
  It restores all four original server binaries into the prepared AppDir and
  removes `libwayland-client.so*`, which conflicts with host Mesa/EGL.
- Never run linuxdeploy over restored server resources: its ELF patching makes
  the static PIE Linux runtimes segfault even for `--fingerprint`. Repack with
  the AppImage output plugin alone, using the copy cached by Tauri.
- Verify the final extracted image contains byte-identical runtimes, excludes
  the Wayland client, and runs the native x64 server with the original
  fingerprint. Missing inputs, changed bytes, or server failure must stop CI.
- Re-sign the final AppImage with `pnpm tauri signer sign` after replacement;
  Tauri's initial `.sig` covers the pre-finalization bytes and is stale.
- Run `python3 tests/packaging/test-linux-appimage.py` for portable orchestration tests.
  These use a fixture packer; Linux CI must also run final-artifact verification,
  and desktop testing must validate UI and Pi connections on the target host.

### Manual development runtime builds

#### 1. Scope / Trigger

Dev startup, manual server/extension builds and deployment isolation.

#### 2. Signatures

- `pnpm server:build [target]` runs `scripts/build-server.mjs` for manual local
  development builds. There is no separate `:dev` command.
- Release CI still calls `bash scripts/build-pilo-server.sh [target]` without
  `--dev` and stages production resources; do not replace it with the dev entry.
- `bash scripts/build-pilo-server.sh --dev [target]` builds a debug runtime in
  `target/<rust-target>/debug/`, without a staging copy.
- `PILO_DEV_WSL_DISTRO` optionally selects the Windows build distro.
- Dev defaults: `CARGO_BUILD_JOBS=1`, `CARGO_PROFILE_DEV_DEBUG=0`; callers may
  override them. Production build settings remain unchanged.

#### 3. Contracts

- Dev startup never builds WSL/SSH runtimes or watches plugins specially. Keep
  Tauri's normal Rust watcher and the shared desktop/WebUI frontend watchers.
- Local debug uses the desktop's embedded server. WSL/SSH debug loads manually
  built binaries from `target/<rust-target>/debug/pilo-server` (Windows: `.exe`),
  never production fallback.
- Windows manual builds run through WSL against the Windows checkout; POSIX builds
  run directly. Default to the build environment's native target. Cross-target
  builds need the target toolchain/linker. Use the workspace’s normal `target/`
  directory for Cargo output, with no `target/pilo-dev` build or staging tree.
  Dev builds neither copy binaries to resources nor deploy running environments.
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

- Manual build failure: propagate nonzero exit; do not deploy or restart Pi.
- Missing debug target: explicit error directing users to `pnpm server:build`.
- No WSL on Windows: manual remote build fails; Local dev startup still works.

#### 5. Good / Base / Bad Cases

- Good: rebuild after a plugin edit; restart and deploy only dev resources.
- Base: Local dev compiles its embedded server with the desktop.
- Bad: dev startup forces a cold WSL build, or shares production runtime paths.

#### 6. Tests Required

Pending explicit authorization: standard Cargo output paths, absence of a staging
copy, build failure propagation,
Windows WSL paths, missing target errors, plugin deployment on Local/WSL/SSH,
production/dev coexistence and source sync isolation.
`current_platform_resolves_its_server_runtime` checks the Cargo filename in
Debug, or the exact missing-dev-runtime error when no standalone dev build
exists; Local debug uses the embedded server and needs no manual build.
Release still requires an existing binary with the packaged resource filename.
These updated assertions have not been run. No end-to-end runtime validation
is implied by syntax/lint checks.

#### 7. Wrong vs Correct

Wrong: dev startup automatically builds remote servers, or dev binaries overwrite
`src-tauri/resources/`. Correct: explicit dev builds and isolated runtime roots;
startup only deploys an already built server and its embedded plugins.

### Release server runtime set cache

#### 1. Scope / Trigger

`server-runtimes.yml` serves standalone main builds and the reusable release job.
Check the complete binary set on Ubuntu before scheduling native build runners;
Cargo dependency caches alone cannot avoid macOS runner queue time.

#### 2. Signatures

- `prepare` exports `cache-hit`, `cache-key`, and the resolved stable `toolchain`.
- The cache key is `pilo-server-runtimes-v1-<sha256>`, hashing `rustc --version`
  and `git ls-tree -r HEAD` entries for workspace/desktop manifests, `Cargo.lock`,
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
