# M0 working notes (scratch; fold into per-spike conclusions before finishing)

## nsh facts confirmed from source/docs (v0.6.0)

- Docs mirror: every page at `https://nsh.dev/<path>.md`; index `https://nsh.dev/llms.txt`. Source tag `v0.6.0` of `longbridge/nsh`; reference example for Rust exports: `examples/rust-exports` (`nsh.json` `"rust": "native"`, crate with `nsh-core` + `nsh-base` deps).
- `nsh init <dir> --template mixed` scaffolds TSX app + Rust crate (`nsh.json` `"rust": "."`, `#[native_module("<name>/native")]`, `registry.register::<Component>().module::<M>().class::<C>()`). Generated TS declarations land in `.nsh/types/<name>/native.d.ts`; `.nsh/` and `target/` are gitignored.
- Rust export rules: non-`async` fn runs inside the TSX call; `async fn` returns a Promise and runs as an engine task; `Callback<A, R>` is a TSX function Rust can call now or later with `post` / `call_async`; a listener registration is named `on(event, listener)` and returns `Stop` (`Stop::new(|| ..)`); args/results: numbers, strings, `Option`, `Vec`, `#[derive(JsObject)]` structs, `#[derive(PropEnum)]` enums, class instances.
- Tokio: `nsh_core::element::ambient::background(future)` is literally `tokio::spawn(future)` and `blocking(f)` is `spawn_blocking` on the surface's runtime; engine tasks are polled inside a Tokio runtime context (`Handle::try_current()` works there). nsh-core depends on tokio with `rt`, `time` (+ `net`, `io-util`, `sync`, `macros` on native).
- Tests: `nsh test` runs `*.test.tsx` headless after `cargo test` of the crates; `--target macos` for native screenshots and real input.
- The generated README recommends replacing cargo with the `huacnlee/cargo` fork; not needed and not done.

## Pilo runtime coupling observed

- No Pilo data dir exists on this VM (`~/Library/Application Support/app.hsingjui.pilo*`): real data has to be created first (run the Tauri build once, or let the runtime create it).
- `tauri` is an unconditional dependency of `src-tauri` (no `tauri` feature yet). `AppHandle` is a parameter of nearly every runtime entry point: `storage::open(app)`, `project::list(app)`, `session_index::list_cached(app, project_id)`, `pi_workspace::*`, `PiloRuntime::new(app)` (`runtime/events/mod.rs:403`), `HostPaths::from_app(app)`.
- Usage is mostly `app.state::<T>()`, `app.path().app_data_dir()`, `Emitter::emit`, `tauri::async_runtime::spawn(_blocking)`, `ipc::Channel` (events/mod.rs), `asset_resolver` (remote/api/mod.rs).
- Candidate minimal-diff extraction: a crate-local `host` module exporting `AppHandle` / `Manager` / `Emitter` / `async_runtime` — re-exports of Tauri's with the `tauri` feature on, own implementations (type-map state, explicit data dir, event sink) with it off — so runtime files only change their `use tauri::…` line.

## Spike 4 (shared TS logic) — measured

- App lives in `desktop/` (`nsh.json` `"rust": "native"`, crate `desktop/native`, module `app/native`).
- Bare imports resolve from the repo root `node_modules` (parent of `desktop/`); before `pnpm install` the bundler failed with `could not load module 'i18next'`.
- `@/` needs `"resolve": { "alias": { "@": "../src" } }` in `nsh.json` (the bundler ignores tsconfig `paths`) plus `"@/*": ["../src/*"]` in `desktop/tsconfig.json` for `nsh check`. Overriding `paths` in the app tsconfig replaces the generated ones, so `nsh`, `nsh/*` and `app/*` have to be repeated there.
- Run time: reducer, replay, runtime adapter all run unchanged (`nsh test`: 4 passed).
- Type check (`nsh check` = tsc over everything reachable, nsh JSX, no DOM lib): 680 errors at first, all in React/DOM files reached through `import type`:
  - `lib/chat/{chat-activity-state,chat-tool-result,conversation-types}.ts` → `components/chat/chat-activity.tsx` (activity types). Fixed by moving the 4 types to `src/lib/chat/chat-activity-types.ts` (re-exported from the component).
  - `conversation-reducer.ts` → `i18n/index.ts` → `host-preferences.ts` → `preferences-provider.tsx`. Fixed by `src/i18n/instance.ts` (the bare i18next singleton); the reducer imports that.
  - After both: reducer + replay + types check clean. Still failing (58 errors): `conversation-runtime-adapter.ts` → `lib/api/pi-runtime.ts` / `pi-runtime-types.ts` → `sessions.ts` (`@tauri-apps/api`, `window`), `theme-settings.ts` (`localStorage`), `host-preferences.ts` → `preferences-provider.tsx`. Left as is; the adapter test sits in `desktop/spikes/unchecked/` (excluded from tsconfig).
- The reducer calls `i18n.t(...)`; in nsh the i18next instance is never initialised by `initializeI18n` (it uses `initReactI18next` and `document`), so the desktop app must initialise i18next itself (resources are plain TS) or the reducer returns keys.

## Spike 1 (Rust runtime) — plan and facts (in progress)

State of the tree when this was written: spike 4 done (`desktop/` app, `desktop/spikes/*.test.ts`, src type seams `src/lib/chat/chat-activity-types.ts` + `src/i18n/instance.ts`; `nsh test` 4 passed, `nsh check` clean). `pnpm install` done in this worktree. Not yet run here: `pnpm build`, any cargo build of `src-tauri` (no `target/`, no `dist/`, `src-tauri/resources/` missing → `mkdir` it before cargo).

Facts about the existing runtime (all in `src-tauri/src/runtime`, one crate `pilo` / lib `pilo_lib`, modules private):
- AppHandle-free entry points already exist at function level:
  - `storage::open_with_paths(&HostPaths)` (schema.rs); `HostPaths { app_data_dir }` has only `from_app(app)` and `#[cfg(test)] for_test(dir)`.
  - `storage::list_projects(&db)` / `storage::list_sessions(&db, project_id)` (tauri-free files).
  - `ServerPiSession::spawn<S: RuntimeEventSink>(&mut self, servers: Arc<ServerManager>, sink: S, project: &Project, options: PiLaunchOptions)` and `send_rpc(Value)` (server_pi.rs, tauri-free). `RuntimeEventSink` is a trait (`fn send(&self, RuntimeEvent)`), `TauriEventSink` is one impl (events/mod.rs).
  - `ServerManager::default()`; only `ssh_target_is_current` needs `control_app` (AppHandle).
- AppHandle-bound: `session_index::reconcile(app, servers, project)` (storage::open(app) + pi_workspace), `project::*`, `PiloRuntime::new(app)`, `RuntimeEventBus` (ipc::Channel).
- Local `pilo-server` launch (server_deploy.rs `spawn_server`): debug builds re-exec `current_exe() --pilo-server` (main.rs handles the flag); release uses `server_binary(target)` from the resource dir (`initialize_server_resource_dir`). An nsh host binary cannot answer `--pilo-server`, so the nsh app must point at a real `pilo-server` binary (`pnpm server:build` → `target/aarch64-apple-darwin/debug/pilo-server`).
- Tauri usage totals in `src-tauri/src`: 127 `#[tauri::command]`, 49 files mention tauri; in runtime: `app.state::<PiloRuntime>()` ×27, `app.state::<RuntimeEventBus>()` ×19, `app.emit` ×9, `async_runtime::spawn(_blocking)` ×18.

Chosen M0 approach: add one public facade module to `pilo_lib` (no Tauri types in its API) that wraps those AppHandle-free functions; `desktop/native` depends on the `pilo` crate by path (Tauri is still compiled and linked, unused — removing it is M1). `desktop/native` keeps its own `[workspace]` so the root `Cargo.lock` is untouched.

Environment: `pi` 1.5.2 at `/opt/homebrew/bin/pi`, relay provider configured in `~/.pi/agent` (model `deepseek-flash`). No Pilo data dir exists on this VM yet, so real projects/sessions have to be created (real Pi sessions under `~/.pi/agent/sessions`, index through the runtime).

### Correction: the service layer is already AppHandle-free (use it in the facade)

- `chat_service::start(paths: &HostPaths, runtime: &PiloRuntime, events: RuntimeEventBus, request: ChatSessionRequest { project_id, session_key, session_path, no_session, extensions, builtin_extensions })` → `PiSessionSnapshot`; `prepare(...)` same shape. Prompt: `runtime.chat_sessions.send(session_key, json!({"type":"prompt","message":...}))` (frontend: `src/lib/api/chat-session-client.ts:180`). Stop: `chat_sessions.stop(session_key, reason)`.
- `PiloRuntime::default()` builds the whole runtime without Tauri. `RuntimeEventBus::default()` has web events enabled (`for_host()` disables them); `events.subscribe_web()` → `WebEventReceiver::recv().await` → `Arc<SequencedRuntimeEvent>` (Serialize: `sequence` + flattened `RuntimeEventEnvelope { sessionKey, projectId, timestampMs, ..event }`). This is the path the Remote WebUI uses, so nsh can subscribe the same way with no Tauri channel.
- `project::ready_with_paths(paths, &servers, events, project_id)`, `pi_workspace::resolve_checked_pi_runtime_with_paths(paths, &project, extensions)` exist. Check for `session_index` / `project` `*_with_paths` variants before writing new ones (`grep -rn "_with_paths" src-tauri/src/runtime`).
- Facade needs: `HostPaths` public constructor (only `from_app` / test ctor today), local `pilo-server` binary override in `server_deploy.rs` Local arm (static `OnceLock<PathBuf>` next to `SERVER_RESOURCE_DIR` in `server_deploy/target.rs`), and `pub mod` exposure from `lib.rs` (`mod runtime` is private).
- Real data: `pnpm dev` (Tauri, WebDriver build) started in background shell `tauridev` in this worktree to create a real data dir (`~/Library/Application Support/app.hsingjui.pilo`, identifier from tauri.conf.json) with a real project + Pi session; drive it with `pnpm debug:desktop` (WebDriver port 4445).

### Facade written (cargo check of `src-tauri` passes)

- `src-tauri/src/runtime/nsh_spike.rs` (`pub mod`, re-exported as `pilo_lib::nsh_spike`): `SpikeHost::open(app_data_dir, server_binary)`, `.projects()` / `.sessions(project_id)` → `serde_json::Value`, `async start_chat(project_id, session_key, session_path)`, `async prompt(session_key, message)`, `async stop_chat(session_key)`, `.events()` → `SpikeEvents::next().await -> Option<String>` (JSON of `SequencedRuntimeEvent`, `{"type":"lagged"}` on overflow).
- Supporting edits: `HostPaths::new(dir)` (host_paths.rs), `initialize_local_server_binary` / `local_server_binary` (server_deploy/target.rs) + early branch in `spawn_server` Local arm (server_deploy.rs), re-export in runtime/mod.rs, `pub use runtime::nsh_spike` in lib.rs.
- Tauri dev app is running from this worktree (shell `tauridev`, do not dump its output: it is huge); it created the data dir with the `default-workspace:local` project. Still to do there: add a real project + one Pi conversation so the session index has rows.
- Next: `desktop/native/Cargo.toml` add `pilo = { path = "../../src-tauri" }`, tokio, serde_json; module `Pilo` exporting projects/sessions/startChat/prompt/on("event", cb); TSX spike screen that feeds events through `toConversationAction` + `reduceConversation` and records latency (Rust emit timestamp vs JS receive) and frame rate.

### Native bridge written (first `nsh check` build running in shell `nshbuild`)

- `desktop/native/src/pilo.rs`: `#[class] Pilo` — `new(dataDir?, serverBinary?)`, static `nowUs()`, `projects()`, `sessions(projectId)` (return `JsonValue` = `serde_json::Value`, so no JSON.parse in JS), async `startChat`, `prompt`, `stopChat`, `emitTextBurst(sessionKey, projectId, count, perSecond)`, `nextEvents()` (pull model: one batch per await, events stamped with `rustUs`). Registered in `desktop/native/src/lib.rs`; deps `pilo = { path = "../../src-tauri" }`, `serde_json`, `tokio` (sync).
- Facade additions: `SpikeHost::emit_text_burst` (publishes AssistantMessageStart / N AssistantTextDelta / AssistantMessageEnd on the real `RuntimeEventBus`), `SpikeEvents::next() -> Option<Value>`.
- nsh facts: `Callback` is `Rc`-based (engine thread only; `post` from a task), async class members run as engine-thread tasks polled inside a tokio context, `background(fut)` = `tokio::spawn`; TS globals include `performance.now`, `requestAnimationFrame`; `perfStats()` / `setFpsEnabled(true)` give fps + dropped-frame share once a second.
- Dev data: `pnpm dev` (debug build) uses data dir `~/Library/Application Support/app.hsingjui.pilo.dev` (`pilo.sqlite3`) and default workspace `~/.pilo-dev/workspaces/local`; release uses `app.hsingjui.pilo` / `~/.pilo`. `pilo-server` debug binary built at `target/debug/pilo-server` (`cargo build -p pilo-server`).
- Data dir currently has 1 project (`default-workspace:local`), 0 sessions → create a real chat in the Tauri app (WebDriver: `pnpm debug:desktop ...`).

### State after native build (nsh check: Rust side green, 59 s first build of pilo+tauri in `desktop/native/target`)

- Generated TS for the bridge is in `desktop/.nsh/types/app/native.d.ts` (`class Pilo`; `JsonValue` returns are typed `unknown`).
- Real data now exists: Tauri dev app (shell `tauridev`, WebDriver via `pnpm -s debug:desktop type|click|screenshot|eval`) sent one prompt → session row in `pilo.sqlite3` (`default-workspace:local`, preview "Reply with exactly: pilo tauri session one", JSONL under `~/.pi/agent/sessions/--Users-devin-.pilo-dev-workspaces-local--/`). Screenshot evidence: `logs/desktop-1795087794878.png` (copy to research/ when writing the report).
- Spike 4 follow-up: adapter import switched to `@/lib/api/pi-runtime-types` (type-only). Remaining type-graph blockers for `PiloRuntimeEvent` (62 tsc errors in nsh): `pi-runtime-types.ts` → `host-preferences.ts` (→ `preferences-provider.tsx`, `i18n/locale.ts`, `keyboard-shortcuts.ts`, `use-developer-tools.ts`), `next-prompt.ts` (tauri invoke), `prompt-enhancement.ts` (imports `pi-runtime`), `theme-settings.ts`, `api/sessions.ts` (tauri), `use-configuration-revision.ts`, `api/connection-events.ts`. M1 item: move those settings/protocol types into pure `*-types.ts` files.
- Workaround in place: `desktop/types/conversation-runtime-adapter.d.ts` + exact-match `paths` entry in `desktop/tsconfig.json` (types only; the bundle loads the real adapter). `desktop/spikes/unchecked/` removed; `desktop/spikes/runtime-adapter.test.ts` is now type-checked (needs `ConversationReducerContext` annotation — fix pending).
- nsh tooling: `nsh test --target macos` drives the real macOS host with platform input; `--fps` logs perf monitor readings (shown with `-v`); `--trace` prints mount batches/commit times.
- Next: write spike `desktop/App.tsx` (projects + sessions list, message list via reducer, prompt input, burst button, latency/fps stats), tests, run headless + `--target macos`, real Pi prompt, capture numbers and screenshots.

### Spike UI written; first headless run found an nsh constraint

- Files: `desktop/App.tsx` (sidebar projects/sessions, stats, message `List`, composer + burst/FPS/reset buttons), `desktop/src/store.ts` (Pilo bridge + reducer + latency stats), `desktop/spike/reducer-context.ts`, `desktop/App.test.tsx` (2 tests), `desktop/types/conversation-runtime-adapter.d.ts`. `nsh check` + `nsh build` clean. Run tests with `PILO_DATA_DIR=$HOME/scratch/pilo-nsh-test-data nsh test` (keeps tests off the dev data dir).
- FINDING (nsh 0.6.0): `nsh_core::background()` is a bare `tokio::spawn`; called from a synchronous JS call (a class constructor) it panics "there is no reactor running" — only tasks (async members) are polled inside the runtime (`blocking()` falls back to `executor().runtime()`, `background()` does not). Fix on our side: the Pilo host owns its own multi-thread tokio runtime and spawns on its handle (the Tauri app equally owns one via `tauri::async_runtime`).
- Headless runner first build: 51.6 s. TextProps has no `numberOfLines` / `selectable`: use classes `line-clamp-1`, `select-text`.

### Headless green (5/5, `PILO_DATA_DIR=$HOME/scratch/pilo-nsh-test-data nsh test`, 8.2 s warm)

- `Pilo` now owns a multi-thread tokio runtime (`runtime.spawn(...)`, helper `Pilo::run`); async members await the JoinHandle on the engine thread.
- Burst test (300 deltas @ 100/s through the real `RuntimeEventBus` → `nextEvents()` → `toConversationAction` → `reduceConversation` → `List`) passes headless in 3.1 s.
- Harmless log: `channel.drop_no_subscriber` warn from the bus (no Tauri channel subscribed).
- Next: `nsh run` on macOS against the dev data dir (default in debug = `app.hsingjui.pilo.dev`): screenshot of real project/session list, real Pi prompt streamed, latency numbers from the Stats line, FPS via the FPS button / `--fps`; then `nsh test --target macos`.

### macOS native window up (`nsh run --fps --window-size 1100x720` in shell `nshrun`, from `desktop/`)

- EVIDENCE `research/evidence/m0-1-nsh-macos-session-list.jpg`: nsh AppKit window "Pilo" lists project "Default workspace" (`/Users/devin/.pilo-dev/workspaces/local`) and SESSIONS (1) "Reply with exactly: pilo tauri session…" — the session the Tauri dev app created (`research/evidence/m0-1-tauri-dev-session.jpg`), read from the same `pilo.sqlite3` through `storage::list_projects/list_sessions`.
- Perf monitor panel (top right) idle: 60 Hz display, TICK 17.21 ms, JS 0.36 ms p95 0.52, CORE 0.07 ms, MEM 27 MB, HEAP 1 MB, NODES 51.
- Don't pipe `nsh run` through grep (block-buffered, no output); read the app's Stats line from screenshots / accessibility instead.
- Next: type a prompt in the nsh window, Send → real `pi --mode rpc`; record Stats line (rust→js p50/p95/max, reduce p95); then Burst 3000 @ 1000/s with FPS panel; screenshots into `research/evidence/`.

### First real prompt from the nsh window: chat start FAILED (investigating)

- Typed a prompt + Enter in the nsh window: Stats showed `status: failed`, `events 3 in 2 batches · rust→js p50 0.18 ms p95 0.27 ms max 0.27 ms · reduce p95 0.03 ms`; no message rendered (startChat rejected before the local submit; the rejection text was overwritten by the `process_state: failed` event). Input + Enter-to-submit worked in the native window.
- Doing: add a separate `error` signal/line to `spike/store.ts` + `App.tsx`, rerun `nsh run --fps --window-size 1100x720 > ~/scratch/nshrun.log 2>&1` (no grep) to read the real error (suspects: local `pilo-server` spawn via `PILO_SERVER_BINARY`/default `target/debug/pilo-server`, `PILO_SERVER_RUNTIME_DIR`, or pi executable resolution).

### Real error from the nsh window: `Error: Pilo Host control is unavailable`

- Rerun: `cd desktop && (nsh run --fps --window-size 1100x720 > ~/scratch/nshrun.log 2>&1 &)`; the window's Stats now has a red `failure` line (`spike/store.ts` `failure` signal). Input field is at screen (580,511), Enter submits.
- `startChat` rejects with "Pilo Host control is unavailable" (status stuck at `starting`, 3 events delivered). Find the string in `src-tauri/src/runtime` (likely `ServerManager.control_app` being `None`, i.e. the host-control endpoint that needs the Tauri `AppHandle`, on the `project::ready_with_paths` / agent-control path) and decide the smallest AppHandle-free way through for the facade.

### Cause of "Pilo Host control is unavailable"

- `ServerPiSession::spawn` (`src-tauri/src/runtime/server_pi.rs:452`): when `options.agent_control` is true it calls `servers.control_app()?` (the Tauri `AppHandle` stored by `ServerManager::initialize_control`) to attach the agent-control stream (`runtime/control::attach(app, ...)`). The nsh host has no AppHandle → error. FINDING for M1: agent control (`runtime/control`) is one of the AppHandle-bound subsystems; chat launch depends on it by default.
- Fix for M0 (pending): find where the chat launch sets `agent_control: true` (grep `agent_control` outside server_pi.rs, likely `chat_sessions.rs`) and let the launch skip agent control when the manager has no control app (e.g. `agent_control: servers.has_control()`), keeping Tauri behaviour identical. Then rebuild (`nsh check`), rerun the window, send the real prompt.
- Fix applied: `ServerManager::{disable_agent_control, agent_control_enabled}` (AtomicBool, default enabled → Tauri unchanged), `server_pi.rs` checks `options.agent_control && servers.agent_control_enabled()`, `SpikeHost::open` calls `runtime.servers.disable_agent_control()`. Needs: `cargo check` in src-tauri, then restart `nsh run` (Rust change restarts) and resend the prompt.

### State at 03:41 (machine clock)

- `nsh run` (log `~/scratch/nshrun.log`) auto-rebuilt after the Rust change (18.1 s) and relaunched the nsh window; `pnpm dev` (Tauri, shell `tauridev`) also rebuilt and its "Pilo Dev" window came to the FRONT, covering the nsh "Pilo" window — my resend keystrokes went to the wrong window (nothing sent).
- Next: hide the Tauri window (it is frontmost: cmd+h), click the nsh window's input (~(580,511) when the nsh window is at its default place), type the prompt, Enter, wait, screenshot → expect streamed real Pi reply + Stats numbers. Then "Burst 3000 @ 1000/s" (button ~(500,537)) and read the FPS panel. Save screenshots to `research/evidence/m0-1-*.png`.
- Evidence so far in `research/evidence/`: `m0-1-nsh-macos-session-list.jpg`, `m0-1-tauri-dev-session.jpg`.

### REAL Pi conversation through nsh: PASS (03:41)

- EVIDENCE `research/evidence/m0-1-nsh-macos-real-pi-stream.jpg`: nsh window, prompt "Count from 1 to 40, one number per line." typed in the native Input + Enter → `chat_service::start` → local `pilo-server` → `pi --mode rpc` → events → `nextEvents()` → `toConversationAction` → `reduceConversation` → `List`: user message + assistant reply 1..40 rendered; status back to `idle`; SESSIONS (2) now lists the new session (re-read from SQLite after the turn) above the Tauri-created one.
- Stats line (real Pi, relay model deepseek-flash): `events 13 in 13 batches · rust→js p50 0.21 ms p95 1.34 ms max 1.34 ms · reduce p95 1.80 ms`. Perf panel: 60 Hz, TICK 16.78 ms p95 22.68, MAIN 1.16 p95 2.26, JS 0.33 p95 0.80, CORE 0.21 p95 0.71, drop 0%, MEM 33 MB, HEAP 1 MB, NODES 70. (Only 13 events: the relay delivers large chunks, so high-frequency load must come from the burst.)
- Next: press "Burst 3000 @ 1000/s" (~(500,537)), screenshot during + after (FPS panel fps/drop, Stats line) → `evidence/m0-1-nsh-macos-burst-*.png`; also Burst 300 @ 100/s. Then stop `nsh run`, keep/stop `tauridev`, move on: run `nsh test --target macos`, M0-3 Composer spike (Input vs RichEditor: IME, @ popup, paste image, file drop, Enter/Shift+Enter), final report `research/m0-conclusions.md`, design.md update, checks (pnpm format/check/build, cargo fmt/check/clippy, nsh check/test), commit, PR (English title), Windows child session.

### Burst 3000 @ 1000/s in the macOS window (03:41) — frame drops, needs analysis

- EVIDENCE `research/evidence/m0-1-nsh-macos-burst-3000.jpg`. Stats: `events 3002 in 615 batches · rust→js p50 4.26 ms p95 16.88 ms max 27.03 ms · reduce p95 <cut off by the perf panel>`; `dropped 25.8%`. Perf panel after the burst: TICK 16.67 p95 21.54, MAIN 11.56 p95 29.74, drop 26%, JS 3.67 p95 10.81, CORE 11.73 p95 22.92, HOP 5.91 p95 19.46, MEM 47 MB, NODES 82. All 3002 events arrived (no `lagged`), batching worked (≈4.9 events per round trip), but 26% of frames ran over one refresh and the burst message itself is not visible in the screenshot (the list did not follow to the end — spike UI has no stick-to-bottom).
- Likely cause to verify, not yet proven: the spike renders the whole growing assistant text in ONE `<Text>` (3000 tokens ≈ 30 kB re-laid out on every batch → CORE/MAIN cost grows with message length), i.e. the cost is text re-layout of a single huge node, not delivery (rust→js p50 4 ms). The React client splits/markdown-renders differently. To check: scroll to the burst message; rerun "Burst 300 @ 100/s" (~(397,537)) and compare drop%; consider coalescing reducer output per animation frame (`requestAnimationFrame`) and/or splitting text into paragraphs/lines so only the tail re-lays out; record both numbers.
- The Stats line is clipped by the perf panel: move `reduce p95` to its own line or shorten.
- Stats line split: `reduce p95` now on its own line in `desktop/App.tsx` (TSX hot-reloads in the running `nsh run`; conversation state resets only if the store module initializer changed).

### Burst 300 @ 100/s in the macOS window (03:42) — clean

- EVIDENCE `research/evidence/m0-1-nsh-macos-burst-300.jpg` (after Reset, then Burst 300 @ 100/s): `events 302 in 301 batches · rust→js p50 0.14 ms p95 0.54 ms max 0.97 ms`, `reduce p95 0.24 ms`, `dropped 0.0%`. Perf panel: TICK 16.66 p95 20.66, MAIN 1.63 p95 2.91, JS 0.34 p95 0.95, CORE 1.22 p95 1.59, HOP 0.04 p95 0.06, drop 0%, MEM 52 MB, NODES 86. token0..token299 rendered in one assistant `<Text>`.
- So: at 100 events/s (above a real model's token rate) delivery is sub-millisecond and no frame is dropped; at 1000 events/s into a single growing 30 kB `<Text>` 26% of frames overran (CORE 11.7 ms p95 22.9 — text layout of the whole node per batch). Cause hypothesis (single-node re-layout, grows with message length) still UNVERIFIED: verify by coalescing to one `conversation.set` per animation frame and/or chunking text, then rerun Burst 3000 (button ~(500,537); Reset ~(613,537)).
- Button coordinates in the nsh window (default position): Burst 300 (397,537), Burst 3000 (500,537), FPS (572,537), Reset (613,537), input (580,511).

### In progress (03:43): testing the frame-drop hypothesis

- Editing `desktop/src/store.ts` `pump()` (lines ~100-127): today every `nextEvents()` batch does `conversation.set(state)` + `publishDelivery()` at once. Change under test: keep reducing into a module-level `pending` state per batch, but write the signals (`conversation`, `delivery`, status/sessions on turn end) once per display frame via `requestAnimationFrame` (one scheduled frame at a time). Then `nsh check`, Reset, rerun Burst 3000 @ 1000/s, compare with the 26% drop / CORE p95 22.9 ms baseline, save `evidence/m0-1-nsh-macos-burst-3000-coalesced.jpg`.
- If drops stay: the cost is layout of one huge `<Text>`; try splitting assistant text by line/paragraph in `Messages` so only the tail re-lays out, and record that too.
- Still running: `nsh run` (log `~/scratch/nshrun.log`), Tauri `pnpm dev` (shell `tauridev`, window hidden with cmd+h). Stop both before running the final checks.
- Frame coalescing written in `desktop/src/store.ts` (`pending` + `flush()` via `requestAnimationFrame`); check/test result of this edit must be read from the next command output; then Reset + Burst 3000 in the window.

### Burst 3000 @ 1000/s WITH per-frame coalescing (03:44)

- Coalescing edit: `nsh check` clean, `nsh test` 5/5 passed.
- EVIDENCE `research/evidence/m0-1-nsh-macos-burst-3000-coalesced.jpg` (zoom of Stats + perf panel): `events 3002 in 1142 batches · rust→js p50 0.16 ms p95 15.87 ms max 26.49 ms`, `reduce p95 0.05 ms`, `dropped 14.2%`. Panel: TICK 16.68 p95 21.05, MAIN 4.20 p95 23.11, JS 0.13 p95 1.01, CORE 1.65 p95 20.11, HOP 0.08 p95 0.18, drop 14%, MEM 51 MB, NODES 74.
- Compared with uncoalesced (26% drop, JS 3.67 p95 10.81, CORE 11.73 p95 22.92, rust→js p50 4.26 ms): JS cost and median latency fell ~25x, drops halved, but the panel's bar chart shows the overruns clustered at the END of the burst (long text) with CORE p95 ~20 ms → remaining cost is native layout of one growing ~30 kB `<Text>`, which grows with message length. Hypothesis now supported by the timing shape, still not isolated.
- Next check to isolate: render assistant text split into lines/paragraph chunks (only the tail node changes) and rerun Burst 3000; if drops go to ~0, the M3 message renderer must chunk streaming text (it will anyway: markdown blocks). Then finish M0-1 write-up.

### Next edit (not yet made, 03:45)

- `desktop/App.tsx` `Messages()` (lines 99-117) renders each message's whole text in ONE `<Text class="text-sm text-foreground select-text">`. To isolate the layout cost: split the text into fixed chunks (e.g. every 400 chars, or by line) with `<Each of={chunks(text)} key={(_, i) => i}>` so only the last chunk's node changes per frame; `nsh check`; Reset (613,537) + Burst 3000 (500,537); zoom region [344,94,864,210]; save as `evidence/m0-1-nsh-macos-burst-3000-chunked.jpg` and record drop% / CORE p95 against 14.2% / 20.11 ms.

### Burst 3000 @ 1000/s with coalescing + chunked text (03:45): hypothesis CONFIRMED

- `desktop/App.tsx` `Messages()` now renders text in 400-char `<Text>` pieces (`chunks()`), `nsh check` clean.
- EVIDENCE `research/evidence/m0-1-nsh-macos-burst-3000-chunked.jpg`, read ~6 s after the press like the other runs: `events 3002 in 1682 batches · rust→js p50 0.12 ms p95 2.79 ms max 5.74 ms`, `reduce p95 0.06 ms`, `dropped 0.0%`. Panel: TICK 16.94 p95 21.82, MAIN 1.46 p95 2.16, JS 0.51 p95 3.98, CORE 0.17 p95 1.27, HOP 0.26 p95 0.15, drop 0%, MEM 51 MB, NODES 218.
- Table (Burst 3000 @ 1000/s, macOS 60 Hz, debug build): per-batch writes + one Text → drop 26%, CORE p95 22.92 ms, rust→js p50 4.26 / p95 16.88 ms; per-frame writes + one Text → drop 14.2%, CORE p95 20.11, p50 0.16 / p95 15.87; per-frame writes + 400-char pieces → drop 0.0%, CORE p95 1.27, p50 0.12 / p95 2.79, max 5.74.
- Conclusion for M3: write signals once per frame and never keep a streaming reply in one text node (block/paragraph nodes; markdown blocks do this naturally).
- Caveat to close: readings are taken after the burst ended; take one mid-burst reading (press, wait ~2 s, zoom) to confirm the panel during load.

### Mid-burst reading (03:46): M0-1 macOS numbers complete

- EVIDENCE `research/evidence/m0-1-nsh-macos-burst-3000-chunked-midburst.jpg` (2 s into Burst 3000 @ 1000/s, status `streaming`): `events 2393 in 1341 batches · rust→js p50 0.15 ms p95 2.79 ms max 37.87 ms`, `reduce p95 0.06 ms`, `fps 56 of 60 Hz · dropped 0.0%`. Panel: 57 FPS, TICK 16.96 p95 19.56, MAIN 2.30 p95 4.29, JS 0.45 p95 3.63 (120/s), CORE 0.25 p95 1.91, HOP 0.23 p95 0.47, eng 39%, CPU 62%, MEM 51 MB.
- M0-1 verdict on macOS: PASS (real list, real Pi stream, sub-ms median latency, 57/60 fps with 0% dropped at 1000 events/s once writes are per-frame and text is chunked). Open items for M1 recorded above (agent control needs AppHandle; `background()` needs a task context; local `pilo-server` binary must be shipped/pointed to; Tauri still linked).
- Next: stop `nsh run` (pkill -f "nsh run"; pkill pilo-desktop host), start M0-3 Composer spike (separate entry, e.g. `desktop/spikes/composer/`), using `Input` (multiline) vs `RichEditor`.

## Spike 3 (Composer) — API facts gathered (nsh 0.6.0, from `.nsh/types` + `nsh-src/website/elements/{input,rich-editor}.md`)

- `nsh run` stopped; Tauri `pnpm dev` still running (hidden).
- `Input` (`nsh/base`): `multiline`, `submitBehavior="submit"` (doc: multiline + submit sends on Return, Shift+Return / Alt+Return inserts a line break on hardware keyboards; a Return that commits an IME composition only commits), `onSubmit({text})`, `onChange({value})`, `onSelectionChange({start,end})`, `onCaretMove({bounds,pageBounds})` (pageBounds is an `Overlay` `anchor` — documented for @-mention popups), `onCompositionChange({composing,text})`, `onPaste({text,html,files: File[],uris})`, `pasteBehavior: "insert"|"report"`, `onKeyPress({key})`; ref: `insertText(text)`, `setSelection(start,end?)`. Plain text only (a mention is text).
- `RichEditor` (`nsh/base`, ProseMirror/Tiptap port in Rust): `createRichEditor({ schema: withMention(starterSchema()), plugins: [suggestion({key:"mention", char:"@", captureKeys:[...]}), starterKit()] })`, `editor.on("transaction", ...)`, `editor.suggestion(key)` → `{active, range, query, lastKey, open}`, `setSuggestionOpen(open,key)`, `insertMention(range,id,label)`, `editor.coordsAtPos`, props `bubbleMenu` / `bubbleMenuPlacement` (anchored at caret), `onPasteFiles({paste:{files:[{name,mime,data}],uris}})`, `onFileDrop({uris,mimeTypes})`, `onCompositionChange({composing})`, `class="max-h-40"` for a growing composer. App keys: `new RichEditorPlugin(key).captureKeys(["Enter"], cb)` + `.capturing = true`; `keymap({"Shift-Enter": command(...)})`.
- Any `View`: `onFileDrop({uris,mimeTypes,pagePosition})`, `onFileDragEnter/Leave`.
- Plan: `desktop/Composer.tsx` entry (run with `nsh run Composer.tsx`), two composers side by side (Input vs RichEditor) with an event log; test on macOS with a Chinese IME (need to enable a Pinyin input source), `@` popup, image paste (copy a PNG to the clipboard), file drop from Finder, Enter / Shift+Enter.

### Composer spike written (`desktop/Composer.tsx`, `nsh check` + `nsh build Composer.tsx` clean)

- Two panels: `InputComposer` (multiline Input, `submitBehavior="submit"`, regex `@query` before caret, `Overlay anchor={caret pageBounds}`, `insertText` mention, `onPaste`, `onFileDrop` on the wrapping View) and `RichComposer` (`withMention(starterSchema())`, `suggestion({captureKeys: ArrowUp/ArrowDown/Enter/Tab})`, `RichEditorPlugin("send").captureKeys(["Enter"])`, `bubbleMenu`, `onPasteFiles`, `onFileDrop`). Event log at the top.
- macOS IME helper: `~/scratch/ime/ime` (swift; `ime list|enable <id>|select <id>`). Enabled `com.apple.inputmethod.SCIM` + `com.apple.inputmethod.SCIM.ITABC` (Simplified Pinyin). Select with `~/scratch/ime/ime select com.apple.inputmethod.SCIM.ITABC`, back with `... select com.apple.keylayout.ABC`.
- To run: `cd desktop && (nsh run Composer.tsx --window-size 1100x720 > ~/scratch/nshcomposer.log 2>&1 &)`.
- Test list per composer: type text; Shift+Enter newline; Enter sends; `@` shows popup at caret, arrows move, Enter/Tab/click picks; switch to Pinyin, type `nihao` + space → 你好, Enter during composition must not send; paste an image (copy PNG to clipboard via `osascript -e 'set the clipboard to (read (POSIX file "...png") as «class PNGf»)'`); drag a file from Finder onto each composer.

### Composer macOS results so far (window running, log `~/scratch/nshcomposer.log`)

Input variant (click at ~(400,523)):
- typing ✓; Shift+Return → newline, no send ✓; `@src` → Overlay popup at the caret (above, start-aligned) with matches ✓ (screenshot `~/screenshots/ss_e45daacf.png`).
- macOS autocorrect capitalised "hello"→"Hello" until `autoCorrect={false}` + `autoCapitalize="none"` were set.
- ArrowDown while the popup is open: NOT reported by `onKeyPress` and cannot be captured (a View's `captureKeys` doc: "focused native inputs keep their keys") → arrow-key navigation of a mention list is not possible with `Input`; only Return (via `onSubmit`) and pointer picks.
- FINDING: `InputRef.insertText` is a no-op on macOS in nsh 0.6.0 — source `nsh-src/crates/nsh-platform-macos/src/mount.rs:740`: `Command::InsertText(_) => log::warn!("insertText is not supported on macOS yet; nothing inserted")`. `setSelection` works. So a mention must be inserted by writing the controlled `value` (loses the native undo step) + `setSelection`. (Check the Windows backend for the same.)
- In progress: switch `pick` in `InputComposer` to the controlled write, then test Enter-send, IME, paste image, file drop; then the RichEditor panel (click ~(684,523)).
- Input: mention via controlled `value` write + `setSelection` ✓, typing continues after it ✓, Return sends `SEND "see @src/lib/chat/conversation-reducer.ts and more"` and clears ✓ (evidence `m0-3-macos-input-mention-popup.jpg`, `m0-3-macos-input-mention-send.jpg`). `insertText` is unsupported on Windows too (`nsh-platform-windows/src/mount.rs:472`), supported on Linux.
- Next: IME in Input (`~/scratch/ime/ime select com.apple.inputmethod.SCIM.ITABC`, type `nihao`, zoom, Return/space), then paste image, file drop, then RichEditor panel.

### Input + Chinese IME on macOS: PASS (03:54)

- Tooling: the computer tool's `type`/`key` actions bypass the IME (letters go in raw); real key codes via `~/scratch/ime/keys.sh nsh-app-pilo-desktop-macos-host <codes...>` (System Events; n=45 i=34 h=4 a=0 o=31 space=49 return=36 esc=53, shift-2 for @ needs `key code 19 using shift down`) engage Pinyin (control in TextEdit showed the candidate window).
- EVIDENCE `m0-3-macos-input-ime-composition.jpg`: `ni hao` underlined in the nsh Input, system candidate window (你好 …) directly under the caret, `onCompositionChange` on "n" → "ni hao" each key.
- EVIDENCE `m0-3-macos-input-ime-commit.jpg`: Return during composition committed `nihao` and did NOT send; space + `nihao` + space committed 你好; field reads `nihao 你好`; `composition off ""` reported.
- Next: Return (sent just now via keys.sh 36) should log SEND "nihao 你好"; then paste image + file drop into Input; then RichEditor panel: same list (typing, Shift+Return, @ popup + arrows + Enter/Tab, IME, IME inside an @ query, paste image, file drop, Return sends).

### Paste image + RichEditor basics on macOS (03:55)

- Image paste (PNG on the clipboard via `osascript -e 'set the clipboard to (read (POSIX file "...png") as «class PNGf»)'`, Cmd+V): Input `onPaste` → `files: [image.png (image/png, 72594 B)]` ✓ (reported twice because I pasted twice — the first click on the RichEditor at y=523 missed it after the layout shifted); RichEditor `onPasteFiles` → `image.png (image/png, 72594 B)` ✓. Both insert nothing into the text. EVIDENCE `m0-3-macos-rich-mention-paste.jpg`.
- RichEditor (click ~(684,523) now; panels moved up after attachments): typing ✓, Shift+Return newline ✓, `@src` → `bubbleMenu` popup above the caret ✓ (EVIDENCE `m0-3-macos-rich-mention-popup.jpg`), ArrowDown moved the highlight to item 2, Return picked it → mention node `@src/lib/chat/conversation-reducer.ts` + space, typing continued ✓.
- Cosmetic: `classes.nodes.mention: "text-primary"` did not visibly colour the mention (check class key later; not a blocker).
- Next: Return in RichEditor must SEND with mentions list; IME in RichEditor (keys.sh), IME inside `@` query; file drop on both (Finder drag of `~/scratch/ime/readme-drop.txt`).

### RichEditor on macOS (03:56): works except Chinese IME — investigating

- RichEditor Return → `SEND "hello\nrich @src/lib/chat/conversation-reducer.ts done" mentions=["src/lib/chat/conversation-reducer.ts"]` ✓ (EVIDENCE `m0-3-macos-rich-send.jpg`): structured mentions come out of the document, which the plain Input cannot give.
- FINDING: with Pinyin active (menu bar 拼) and the same key-code method, the RichEditor received raw letters `nihao` — no marked text, no candidate window, no `onCompositionChange`; the Input next to it composed normally in the same run. EVIDENCE `m0-3-macos-ime-input-vs-richeditor.jpg` (one image: Input shows `ni hao` + candidates, RichEditor shows raw `nihao`). Reproduced twice.
- nsh internals: RichEditor takes text through an invisible 1 px controlled native `input()` "sink" at the caret (`nsh-src/crates/nsh-base/src/rich_editor/view/render.rs:1594`, `controller.rs` `sink_changed` / `composition_changed`); docs claim IME composition is supported. Not yet known whether my editor config (suggestion plugin + `RichEditorPlugin("send")` capturing Enter + transaction listener) or nsh itself breaks it.
- Doing now: minimal `desktop/spikes/RichMinimal.tsx` (`<RichEditor plugins={["starter","history","baseKeymap"]} autoFocus />`, no app plugins), `nsh run spikes/RichMinimal.tsx`, same Pinyin keys via `~/scratch/ime/keys.sh nsh-app-pilo-desktop-macos-host 45 34 4 0 31`. If it composes → bisect my plugins; if not → nsh 0.6.0 macOS RichEditor IME defect (upstream), which decides Input vs RichEditor.
- Still untested: file drop (both), IME inside an `@` query.

### Minimal RichEditor composes (03:58) → the IME break is in MY Composer config, not nsh's editor

- `desktop/spikes/RichMinimal.tsx` (built-in plugins `starter`, `history`, `baseKeymap` only; running: `nsh run spikes/RichMinimal.tsx --window-size 700x400`, log `~/scratch/nshrich.log`, process name `nsh-macos-host`, window title "spikes"): same Pinyin key codes → `ni hao` underlined, candidate window under the caret, `composition on` reported. EVIDENCE `m0-3-macos-rich-minimal-ime.jpg`.
- So the earlier raw `nihao` in `Composer.tsx`'s RichEditor is caused by one of: `createRichEditor({schema: withMention(starterSchema()), plugins:[suggestion(...), send, starterKit()]})` (an `editor` session instead of built-in plugin names), the `RichEditorPlugin("send")` with `capturing = true` on Enter, the `suggestion` plugin, the `editor.on("transaction")` listener, `bubbleMenu`, or `max-h-40` without a height. NOT yet bisected. Do not report it as an nsh defect until bisected.
- Bisect plan in RichMinimal.tsx (one change at a time, rerun the 5 key codes each time): (1) `editor={createRichEditor({plugins:[starterKit()]})}`; (2) + `schema: withMention(starterSchema())`; (3) + `suggestion(...)`; (4) + `send` capture plugin; (5) + transaction listener; (6) + `bubbleMenu`; (7) `max-h-40`.
- User asked for progress at 19:58 CST; replied with the per-risk status.

### 20:00 CST — user: skip Windows verification for now; report when the rest is done

- M0-2 (Windows) and the Windows half of M0-3 are DEFERRED by the user ("win验证先不用了 上面的做完之后给我说就行"). Do not open a Windows child session. Report them as "not run (deferred)" in the conclusions. Task 4 deleted from the task list.
- Bisect in progress (`desktop/spikes/RichMinimal.tsx`, 5 variants A–E in one window "spikes", process `nsh-macos-host`; click a variant then `~/scratch/ime/keys.sh nsh-macos-host 45 34 4 0 31 49`): A built-in names ✓ composes (你好), B session + starterKit ✓, C + mention schema + suggestion ✓. D (+ `RichEditorPlugin("send")` capturing Enter, click (510,318)) and E (D + `max-h-40`, click (510,366)) NOT yet read — the D key run was interrupted.

### Bisect result (04:00): all five RichEditor variants compose

- EVIDENCE `m0-3-macos-rich-variants-ime.jpg`: A (built-in names), B (session + starterKit), C (+ mention schema + suggestion), D (+ Enter capture plugin), E (D + `max-h-40`) each took Pinyin `nihao`+space → 你好 with `composition off` reported. So none of schema / suggestion / Enter capture / max-height breaks the IME.
- The raw-`nihao` runs in `Composer.tsx` therefore came from something else. Differences left: (a) editor STATE before the keys — both failing runs followed earlier activity in that editor (text typed through the computer tool, a mention inserted, `editor.setContent("")` on send, and in run 2 Cmd+A + Backspace); (b) the `editor.on("transaction")` listener; (c) `bubbleMenu` prop; (d) an `Input` in the same window that had focus before.
- Next: relaunch `nsh run Composer.tsx --window-size 1100x720`, FRESH: click RichEditor (684,523), Pinyin keys at once. Then repeat after each of: computer-tool typing, Cmd+A+Backspace, a send (`setContent("")`), focusing the Input first — to find the trigger.
- 04:01 FRESH `Composer.tsx` RichEditor: Pinyin composes (`ni hao` underlined, candidates under the caret, `RichEditor: composition on`). EVIDENCE `m0-3-macos-rich-composer-ime-fresh.jpg`. So the break is state-dependent. Process name in `~/scratch/ime/proc`. Testing triggers next: Cmd+A+Backspace → keys; computer-tool `type` → keys; send (`setContent("")`) → keys; focus Input → back → keys.
- 04:02 In the fresh Composer RichEditor, Pinyin still composes after Cmd+A+Backspace and after typed text (and the computer tool's `type` DOES go through Pinyin when it is the active source: "rich " became 日常). So neither clearing nor prior text is the trigger. Remaining candidates from the failing runs: a send (`editor.setContent("")` inside the captured-Enter handler), a mention insertion (`insertMention`), an image paste (`onPasteFiles`), or switching the input source ABC→Pinyin while the editor keeps focus (both failing runs did `ime select ITABC` with the RichEditor already focused; the passing runs clicked the editor after selecting). Testing in that order: send → keys; mention → keys; paste → keys; source switch while focused → keys.
- 04:03 In the fresh Composer RichEditor Pinyin keeps composing after each of: source switch while focused, a send (`setContent("")`), a mention insertion, an image paste (`onPasteFiles`). EVIDENCE of the last state: `~/screenshots/ss_zoom_a43ad909.png`. The one thing the failing runs had that these don't: the plain `Input` in the same window had been focused/used (incl. IME + controlled value writes) BEFORE the RichEditor. Testing now: click Input (339,509), Pinyin there, commit, click RichEditor (684,524), Pinyin keys.
- 04:04 Using the Input (Pinyin compose + commit) first and then the RichEditor: RichEditor STILL composes (`~/screenshots/ss_zoom_c442f613.png`). So Input-before-RichEditor is not the trigger either. Not reproducible in a fresh process by any app-level action.
- Last difference: both failing runs were in a dev session that had HOT-RELOADED `Composer.tsx` three times (my `pick` edits) before the RichEditor was used; every passing run is a fresh `nsh run`. Hypothesis: after a TSX hot update the re-made RichEditor's native sink loses IME handling (dev-only). Test now: trivial edit to `Composer.tsx` (placeholder text) while running → wait for hot update → click RichEditor → Pinyin keys.
- 04:05 After one hot update of `Composer.tsx` the re-made RichEditor still composes (`~/screenshots/ss_zoom_f5c5551b.png`). Hot-reload hypothesis rejected (for one reload).
- Not yet tried: a FRESH process whose first focus/typing in the RichEditor happens under the ABC source, switching to Pinyin only afterwards (that was the order in both failing runs; all passing runs had Pinyin active at first focus). Testing now: restart `nsh run Composer.tsx`, `ime select ABC`, click RichEditor (684,523), type + mention + send in ABC, `ime select ITABC`, Pinyin keys.

### 04:06 REPRODUCED the RichEditor IME break in a fresh process

- Steps (fresh `nsh run Composer.tsx`, input source ABC): click RichEditor → type `hello` → Shift+Return → type `rich @src` → Down → Return (mention inserted) → type `done` → Return (SEND, `setContent("")`) → `ime select ITABC` → Pinyin key codes n,i,h,a,o ⇒ raw `nihao` in the editor, no marked text, no candidates, no `composition on`. EVIDENCE `m0-3-macos-rich-ime-broken-repro.jpg`.
- Already shown NOT to break it on their own (in a session whose first focus was under Pinyin): source switch while focused, a send, a mention, an image paste, Cmd+A+Backspace, Input-before-RichEditor, one hot update.
- Untested single factors: (1) first focus/typing under ABC; (2) Shift+Return (hard break) typed under ABC (in the passing session Shift+Return was pressed under Pinyin and made no newline); (3) send of a document containing a mention / a hard break.
- Bisect helper: `~/scratch/ime/fresh.sh` (kills `nsh run`, selects ABC, starts Composer, stores process name in `~/scratch/ime/proc`). Then per test: click (684,523), actions, `~/scratch/ime/pinyin.sh` (select ITABC + 5 key codes), zoom [160,400,864,554].
- 04:06 T1 (fresh process, ABC, click RichEditor, type `hello `, then `ime select ITABC` + keys) ⇒ raw `nihao` (`~/screenshots/ss_zoom_1cd59f50.png`). So no mention/send/hard break is needed.
- NEW SUSPICION — test artifact, not nsh: my `ime select` is `TISSelectInputSource` called from ANOTHER process while the nsh app is frontmost. macOS is known not to apply a programmatic switch to a CJK input method in the frontmost app until its input context is re-activated (app switch / focus change) — the menu bar shows 拼 but keys stay ASCII. That fits every observation: failures = switched while the nsh editor kept focus in a process that never had Pinyin; passes = process started/activated or focus moved to another field after the switch (TextEdit round trip, restart, click on the other field). The earlier "computer tool bypasses the IME" note was this same artifact (later `type` did go through Pinyin).
- Discriminating test now, in T1's broken state: activate Finder, re-activate the nsh app (no other change), Pinyin keys. If it composes ⇒ artifact of programmatic switching; then also switch the way a user does (Ctrl+Space / input menu) to confirm.

### 04:08 RESOLVED: the RichEditor "IME break" was a TEST ARTIFACT, not an nsh or Composer defect

- In T1's broken state, activating Finder and coming back (nothing else changed) ⇒ the RichEditor composes (EVIDENCE `m0-3-macos-rich-ime-after-reactivation.jpg`).
- Same T1 steps but switching to Pinyin the way a user does (menu bar input menu → "Pinyin – Simplified") ⇒ composes at once: `ni hao` underlined, candidates under the caret, macOS's 拼 indicator at the caret, `RichEditor: composition on` (EVIDENCE `m0-3-macos-rich-ime-user-switch.jpg`).
- Cause: `TISSelectInputSource` from another process (`~/scratch/ime/ime select`) does not reach the frontmost app's active input context for a CJK input method until that context is re-activated. RULE for the rest of the tests: switch input source through the menu bar (click (864,9), then Pinyin (913,31) / ABC (886,46)), or re-activate the app after `ime select`.
- CORRECTION OWED TO THE USER: my 19:58 progress message said Pinyin did not compose in my RichEditor Composer config and that I was locating the plugin responsible. That was wrong — say so in the final report. `desktop/spikes/RichMinimal.tsx` (variants A–E) stays as the control that shows all configurations compose.
- Remaining RichEditor checks (Pinyin active now, composition `ni hao` open): Return during composition must commit and NOT send (the Enter-capture `send` plugin is the risk); `@` + Pinyin query (`@zhong` → 中 → matches `中文文档.md`); then file drop on both composers.

### 04:09 RichEditor + Pinyin: PASS on every item

- Return during a composition commits (`nihao`) and does NOT send, even with the Enter-capture `send` plugin (EVIDENCE `m0-3-macos-rich-ime-return-commits.jpg`).
- `@` then Pinyin `zhong`: while composing the popup shows all files (the composing text is not in the document yet, so the query is empty) with the candidate window under the caret (EVIDENCE `m0-3-macos-rich-ime-in-mention-composing.jpg`); after committing 中 the list filters to `中文文档.md` (`...-in-mention-filtered.png`); Return picks it as a mention node; Return sends `SEND "hello nihao @中文文档.md " mentions=["中文文档.md"]` (`m0-3-macos-rich-ime-mention-send.jpg`).
- Left for M0-3 macOS: Input: `@` + Pinyin query; file drop on both composers (Finder drag of `~/scratch/ime/readme-drop.txt`). Pinyin is the active source now (menu-bar switch); process name in `~/scratch/ime/proc`.
- 04:10 Input: `@` + Pinyin `zhong` → popup at the caret + candidate window while composing (all files listed while composing), commit 中 → filtered to `中文文档.md`, Return picks (controlled value write), Return sends `SEND "@中文文档.md "`. EVIDENCE `m0-3-macos-input-ime-in-mention-{composing,filtered}.jpg`, `m0-3-macos-input-ime-mention-send.jpg`. Note: Input `onKeyPress` reports the composing text (`zhong`) as the key during composition, and `Enter`.
- Only file drop is left for M0-3 macOS (Finder window on `~/scratch/ime`, drag `readme-drop.txt` onto each composer).
- 04:11 File drop from Finder (`readme-drop.txt`): Input's wrapping View `onFileDrop` → `file:///Users/devin/scratch/ime/readme-drop.txt` ✓; RichEditor `onFileDrop` → same ✓. EVIDENCE `m0-3-macos-file-drop-both.jpg`. M0-3 macOS checklist complete for both variants.
- Open question before choosing: can `keymap.bind("down", ...)` (nsh `keymap`) take arrow keys while a native `Input` is focused (would remove Input's main gap)? Check `.nsh/types/nsh/index.d.ts` keymap docs.

### 04:12 Input arrow keys SOLVED with `keymap.bind(..., { when: "always" })` — M0-3 macOS complete

- CORRECTION to the earlier finding ("arrow-key navigation of a mention list is not possible with Input"): `keymap.bind({down, up, tab, escape}, { when: "always", repeat: true })`, bound only while the list shows (an `effect` + `cleanup` in `InputComposer`), takes the keys over the focused native input. Verified: Down ×2 moved the highlight to item 3 (EVIDENCE `m0-3-macos-input-arrow-keys.jpg`), Tab picked it, Escape dismissed the list, Return then sent `SEND "see @src-tauri/src/lib.rs ok @r"` (`m0-3-macos-input-tab-escape-send.jpg`). This also corrects what I told the user at 19:58 ("弹层打开时方向键无法拦截").
- Input source is back on ABC (menu bar). Finder window closed.
- Both variants pass the whole macOS checklist. Remaining differences: Input = plain text, `insertText` not implemented on macOS/Windows (mention = controlled value write, no native undo step); RichEditor = mention nodes + `bubbleMenu` + `suggestion` plugin + own history, but `starterKit()` brings Markdown input rules/marks that a prompt box should not have (needs a minimal schema), and its IME path (hidden 1 px sink input) is one more thing to verify on Windows.
- Next: check what the React composer is (textarea?) to pick the equivalent; stop `nsh run` + `tauridev`; write `research/m0-conclusions.md`; update parent design.md; run all checks; commit; PR.

### 04:14 Wrap-up state (all macOS measurements done; nothing running)

- Stopped: `nsh run`, Tauri `pnpm dev` (shell `tauridev` killed), vite, pilo. Input source ABC.
- Evidence converted to JPEG (`sips`, max 1400 px, 5.3 MB total, 32 files) in `research/evidence/*.jpg`; names in these notes updated to `.jpg`. Checked `m0-1-nsh-macos-real-pi-stream.jpg` is legible.
- Caveat seen in that screenshot: the session rows read "0 messages" — the spike lists the cached SQLite index (`storage::list_sessions`) and does not run `session_index::reconcile` (AppHandle-bound), so counts are whatever the index holds. Say so in the conclusions.
- `desktop/native/src/lib.rs` reduced to the `Pilo` class only (scaffold Badge/Format/Counter removed) — NOT yet rebuilt; `nsh-base` dep in `desktop/native/Cargo.toml` may now be unused (remove if so).
- Root tooling facts: `pnpm build` = `tsc && vite build` (tsconfig `include: ["src"]`, so `desktop/` is not in it); `pnpm check` = oxfmt check + `oxlint .` (will see `desktop/**` — may need ignore patterns for `desktop/.nsh`, `desktop/target`, `desktop/native/target`, or formatting of desktop TSX with tabs); `.oxfmtrc.json` ignores `.trellis/**`.
- Remaining: (1) rebuild + `nsh check`/`nsh test`; (2) `research/m0-conclusions.md` (per-risk verdict + recommendation, corrections owed to the user: RichEditor IME "break" was a test artifact; Input arrow keys work via `keymap.bind when:"always"`); (3) update `.trellis/tasks/11-19-nsh-desktop-migration/design.md` "待 M0 验证" items; (4) `pnpm format && pnpm check && pnpm build`, `cargo fmt --all --check`, `cargo check`, `cargo clippy --all-targets --all-features -- -D warnings`; (5) commit on `nsh-migration` topic branch, PR to `nsh-migration` (English title); (6) final message to the user.

### 04:17 Disk full during `nsh test` — build artifacts, cleaned

- `nsh test` failed 1/6 with "No space left on device": `desktop/target` had grown to 24 GB (`target/debug/build/pilo` 5.6 GB, `nsh-base` 3.7 GB — stale artifacts of every rebuild) and `desktop/native/target` to 9.3 GB within one session; disk 123 GB at 100%. The 5 TS tests themselves passed; the failure was the `cargo test` step compiling `pilo`.
- Removed `desktop/target` and `desktop/native/target` (both git-ignored, regenerable). FINDING for M1: nsh builds the app crate (and with it the whole `pilo` + Tauri dependency tree) separately for the native crate, the dev host and the headless test runner, in two target dirs apart from the workspace's `target/` — expect ~10+ GB per clean set until the runtime is a small Tauri-free crate, and clean periodically.
- Next: rebuild (`nsh check`, `nsh test`), record clean sizes, then conclusions doc.

### 04:20 After clean rebuild

- `nsh check` clean; `nsh test` 5 passed / 0 failed (1m28s incl. 48.9 s headless runner build); `nsh build` of `App.tsx`, `Composer.tsx`, `spikes/RichMinimal.tsx` clean. Clean artifact sizes: `desktop/target` 10 GB + `desktop/native/target` 4.7 GB.
- User pinged at 20:18 CST; replied with status AND the two corrections (RichEditor IME artifact; Input arrow keys via keymap.bind). Corrections are delivered — final report only needs the verdicts.
- React composer today: `Textarea` + text mentions (`src/lib/chat/chat-mentions.ts`: file mention = `@"path"` text, parsed by `fileMentionPath`; session mentions in `session-mentions.ts`) → plain-text model; `Input` is the like-for-like and reuses that pure logic.
- Now: root checks (`pnpm format`, `pnpm check`, `pnpm build`, cargo fmt/check/clippy), then conclusions doc + design.md, commit, PR.
- 04:30 Renamed `desktop/spike/` → `desktop/src/` (store.ts, reducer-context.ts) to stop the clash with `desktop/spikes/`; earlier notes that say `desktop/spike/…` mean `desktop/src/…`.
