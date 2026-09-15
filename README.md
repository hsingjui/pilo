<p align="center">
  <img src="./assets/branding/icon.png" width="128" alt="Pilo application icon">
</p>

<h1 align="center">Pilo</h1>

<p align="center">A simple desktop client for Pi Coding Agent that brings Local, WSL, and SSH projects into one workspace while keeping Pi in the environment where the code lives.</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/hsingjui/pilo/actions/workflows/ci.yml"><img src="https://github.com/hsingjui/pilo/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/Desktop-Windows%20x64%20%7C%20macOS%20arm64-4B5563?style=flat-square" alt="Desktop releases: Windows x64 and macOS arm64">
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2024-3776AB?style=flat-square" alt="Rust 2024 edition"></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-3776AB?style=flat-square" alt="Tauri 2"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-3776AB?style=flat-square" alt="React 19"></a>
</p>

Pilo is a desktop client for [Pi Coding Agent](https://pi.dev/), not a separate agent implementation. It presents connections, projects, and Pi sessions in an IDE-style workspace while leaving conversation state and agent behavior to Pi.

## Highlights

| Highlight                                         | Why it matters                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local, WSL, and SSH in one workspace              | Projects stay in their original environments. Pilo runs `pilo-server` in the selected environment instead of copying remote projects to the desktop. |
| Pi runs where the project lives                   | The server starts `pi --mode rpc` with the project directory as its working directory for Local, WSL, and SSH connections.                           |
| Pi stays the source of truth                      | Sessions are read from Pi JSONL files; SQLite only stores rebuildable indexes, caches, and desktop state.                                            |
| Chat, tools, terminals, files, and diffs together | Pilo renders Pi thinking and tool calls alongside PTY terminals, file operations, preview ports, and Git status/diffs.                               |
| Parallel agents                                   | Multiple agent streams can run for a project and can be listed, messaged, or stopped independently.                                                  |
| Native desktop updates                            | Release builds produce updater artifacts for Windows x64 and macOS arm64, and Pilo can check for updates from GitHub Releases.                       |

## Architecture

Pilo consists of a desktop app and a `pilo-server` process that runs in the selected connection environment. Local runs directly, WSL uses `wsl.exe`, and SSH deploys a matching server binary to the remote host. Desktop/server communication uses protobuf `Envelope` frames over stdio through `crates/pilo-protocol`.

```text
┌──────────────────────────────┐
│        Pilo Desktop          │
│       React + Tauri 2        │
└──────────────┬───────────────┘
               │ pilo-protocol / stdio
               ▼
┌──────────────────────────────┐
│          pilo-server         │
│   Local | WSL | SSH target   │
└──────────────┬───────────────┘
               │ pi --mode rpc
               ▼
┌──────────────────────────────┐
│       Pi Coding Agent        │
└──────────────────────────────┘
```

## Quick Install

Pilo is currently built from source. Development requires Node.js 22, pnpm (CI uses 10.12.3), a stable Rust toolchain, and Pi installed in every environment you plan to use.

Pilo discovers `pi` from `PATH` by default. Each connection can also be configured with a custom Pi executable path in Settings.

### Windows

```powershell
pnpm install
pnpm server:build:win
pnpm tauri dev
```

### macOS / Linux

```bash
pnpm install
pnpm server:build
pnpm tauri dev
```

The commands above build the `pilo-server` runtime for the current host only. WSL and SSH connections need a runtime matching the target OS and architecture in `src-tauri/resources/`. Release packaging stages the complete runtime set automatically.

Supported server runtime targets are Linux x64/arm64, Windows x64/arm64, and macOS x64/arm64. An explicit runtime can be built with:

```bash
bash scripts/build-pilo-server.sh <target>
```

## Quick Start

1. Start Pilo with `pnpm tauri dev`.
2. Use the default Local connection, or add a WSL or SSH connection.
3. If Pi is not available as `pi` on `PATH`, set its executable path for that connection in Settings and run the Pi probe.
4. Add a project directory and open a session.
5. Send a message. Pilo starts `pi --mode rpc` in the project directory and streams the session into the workspace.

For WSL or SSH, Pilo probes the target platform and deploys the matching `pilo-server` runtime before starting it. If that runtime has not been staged, Pilo reports the missing resource instead of silently using an incompatible binary.

## Development

| Command                                                                | Purpose                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm check`                                                           | Run oxfmt format checks and oxlint                                |
| `pnpm format`                                                          | Format the frontend with oxfmt                                    |
| `pnpm build`                                                           | Type-check and build the frontend                                 |
| `pnpm test:unit`                                                       | Run frontend unit tests                                           |
| `cargo fmt --all --check`                                              | Check Rust formatting                                             |
| `cargo check --workspace --all-targets --all-features`                 | Check the Rust workspace                                          |
| `cargo test --workspace --all-features`                                | Run Rust workspace tests                                          |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Run Rust lints                                                    |
| `pnpm server:verify`                                                   | Verify the complete six-target `pilo-server` release resource set |

## Repository layout

| Path                    | Contents                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/`                  | React UI: chat, sessions, sidebar, settings, terminals, and project interactions                                |
| `src-tauri/`            | Tauri app: commands, runtime managers, connection/project state, and SQLite indexes                             |
| `crates/pilo-protocol/` | Wire protocol shared by the desktop app and `pilo-server`                                                       |
| `crates/pilo-server/`   | Pi streams, terminals, filesystem operations, preview ports, and session indexing inside the target environment |
| `scripts/`              | Runtime build and verification scripts                                                                          |
| `docs/`                 | Design notes                                                                                                    |

## Third-Party Notices

Some parts of Pilo are derived from third-party open-source software, including Lody. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for source and license details.

## License

Pilo is licensed under the [Apache License 2.0](./LICENSE).

Third-party source and attribution notices are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
