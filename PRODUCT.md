# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who already use the Pi Coding Agent. The primary job is to run and steer Pi
sessions from a desktop workspace instead of the Pi TUI. Their work spans Local, WSL, and
SSH environments, and the code stays in whichever environment it already lives in.

## Product Purpose

Pilo is a simple, non-intrusive desktop client for the Pi Coding Agent. It presents
connections, projects, and Pi sessions in one IDE-style workspace while leaving the agent
loop, conversation state, and session files to Pi.

Success means two things: it replaces the Pi TUI as the daily driver for its own author,
and other Pi users can install it and get a session running without configuration beyond
pointing Pilo at their Pi executable.

## Positioning

Pilo does not reimplement the agent. It is a thin desktop shell over Pi: Pi keeps the run
loop, and Pilo only brings connections, projects, and sessions into one workspace.
The mechanism a neighboring client could not truthfully copy is that Pi runs in the
environment where the code lives — Local directly, WSL through `wsl.exe`, SSH by
deploying a matching `pilo-server` to the host — so remote projects are never copied to
the desktop. Pi's JSONL is the single source of truth; SQLite stores only rebuildable
indexes, caches, and desktop state.

## Operating Context

- Connections are Local, WSL, or SSH. The desktop talks to a `pilo-server` process
  running in the selected environment over protobuf `Envelope` frames on stdio; the
  server starts `pi --mode rpc` with the project directory as its working directory.
- Pi is discovered from `PATH` by default; a per-connection executable path and a Pi
  probe live in Settings.
- Sessions are read from Pi JSONL files, not reconstructed by the desktop.
- Capabilities are exercised together in one window: chat (thinking and tool calls),
  parallel agent streams, PTY terminals, files, preview ports, Git status and diffs.
- Pilo ships as a desktop application (Windows and macOS). The desktop app is the
  product today; a web client is confirmed as later work.
- Development runs in WSL (Debian) for builds and static checks; `pnpm tauri dev` and
  packaged-app verification happen on Windows.
- Distribution is source builds plus GitHub Releases; the project is Apache-2.0.

## Capabilities and Constraints

Confirmed capabilities: streamed chat with thinking and tool calls, multiple parallel
agent streams per project, PTY terminals, file explorer and file operations, preview
ports, Git status and diffs, desktop notifications, and in-app update checks.

Confirmed constraints:

- Every feature must make sense for Local, WSL, and SSH alike. A capability that only
  works for one environment is not finished.
- Desktop business logic stays on Tauri IPC; remote or web clients are an additive layer,
  not a migration of desktop behaviour to HTTP.
- UI copy is currently Chinese-only with no i18n layer. English support is confirmed as
  future work; no scope or timing has been decided.
- Shipped targets are the Windows x64 and macOS arm64 desktop builds; a web client is
  planned afterwards, with no scope or timing decided. The desktop pair is the
  short-term set, not a permanent limit.
- Remote/WebUI (phone browser, Telegram bot) is recorded as Proposed/Deferred in
  `docs/remote-webui-architecture.md`: an architectural constraint to avoid tight Tauri
  coupling, not a near-term feature.

## Brand Commitments

The name is Pilo, with the icon at `assets/branding/icon.png`. Documentation is
maintained bilingually (`README.md` in English, `README.zh-CN.md` in 简体中文). No voice
or tone commitment has been made.

## Evidence on Hand

- `README.md` and `README.zh-CN.md`: bilingual product description, architecture diagram,
  and build instructions.
- `DESIGN.md` and `.impeccable/design.json`: the incumbent visual system (Lody Light,
  Lody Dark = bundled Vesper).
- `docs/`: design notes on streaming performance, the conversation pipeline, and the
  deferred remote/WebUI architecture.
- No adoption numbers, testimonials, benchmarks, or pricing exist. Future work must not
  fabricate them.

## Product Principles

1. Pi owns the agent. Pilo never reimplements agent behaviour or duplicates conversation
   state.
2. Pi runs where the code lives. Never sync a remote project to the desktop.
3. Stay out of the way. The chrome is quiet and the work is the interface.
4. Local, WSL, and SSH are one product, not three.
5. Nothing the desktop can do itself earns a network round trip.

## Accessibility & Inclusion

No product-specific accessibility need has been established by the user. The incumbent
system's documented floor — every text token clears 4.5:1 against the surface it actually
renders on — is recorded in `DESIGN.md`, not as a product requirement here.
