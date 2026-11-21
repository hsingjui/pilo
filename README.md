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
  <img src="https://img.shields.io/badge/Desktop-macOS%20development-4B5563?style=flat-square" alt="Desktop development: macOS">
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2024-3776AB?style=flat-square" alt="Rust 2024 edition"></a>
  <a href="https://github.com/longbridge/nsh"><img src="https://img.shields.io/badge/nsh-0.6-3776AB?style=flat-square" alt="nsh 0.6"></a>
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

## Architecture

Pilo consists of a desktop app and a `pilo-server` process that runs in the selected connection environment. Local runs directly, WSL uses `wsl.exe`, and SSH deploys a matching server binary to the remote host. Desktop/server communication uses protobuf `Envelope` frames over stdio through `crates/pilo-protocol`.

```text
┌──────────────────────────────┐
│        Pilo Desktop          │
│   nsh (TSX + Rust runtime)   │
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

The desktop app is built with [nsh](https://github.com/longbridge/nsh) (install the `nsh` 0.6.1 CLI). Only macOS is currently developed and verified.

```bash
pnpm install
pnpm dev          # keeps dist/ (the WebUI the Host serves) rebuilt, and starts Vite
cd desktop
nsh dev           # the desktop app with hot reload
```

Local uses `target/debug/pilo-server` (`cargo build -p pilo-server`). For WSL/SSH, build a development server for the remote target, then start or restart Pilo:

```bash
pnpm server:build
```

On Windows, run these commands in the Windows checkout. The manual build uses WSL (Rust and Bash must be installed there), with its native Linux target by default. Set `PILO_DEV_WSL_DISTRO` before building to select a distro, for example `$env:PILO_DEV_WSL_DISTRO = "Debian"`. On macOS/Linux, it builds the native server target. To build another remote target, use `pnpm server:build linux-aarch64`; its Rust target and linker must be installed in the build environment.

The dev build defaults to one Cargo job and no debug symbols to reduce WSL memory use. Override `CARGO_BUILD_JOBS` / `CARGO_PROFILE_DEV_DEBUG` explicitly if needed. Production build settings are unchanged.

Development binaries stay in Cargo’s standard output directory, for example `target/x86_64-unknown-linux-gnu/debug/pilo-server`, without a second staging copy. Release resources in `resources/` remain unchanged. On startup/connection, Pilo deploys the matching server into its dev runtime directory; the server writes its embedded plugins into `extensions/`. Rebuild after plugin changes and restart Pilo/Pi to load them. Runtime/extension caches use `pilo-dev/server` instead of `pilo/server` (WSL/SSH: `~/.cache/pilo-dev/server`). Pi settings and session files remain shared.

The nsh desktop release pipeline and update feed are not set up yet. The separate server-runtime workflow builds the four bundled server targets. To stage a runtime manually, use `pnpm server:build:win` on Windows or `bash scripts/build-pilo-server.sh` on macOS/Linux.

Supported server runtime targets are Linux x64/arm64, Windows x64/arm64, and macOS x64/arm64. An explicit runtime can be built with:

```bash
bash scripts/build-pilo-server.sh <target>
```

## Quick Start

1. Start Pilo with `nsh dev` in `desktop/`.
2. Use the default Local connection, or add a WSL or SSH connection.
3. If Pi is not available as `pi` on `PATH`, set its executable path for that connection in Settings and run the Pi probe.
4. Add a project directory and open a session.
5. Send a message. Pilo starts `pi --mode rpc` in the project directory and streams the session into the workspace.

For WSL or SSH, Pilo probes the target platform and deploys the matching `pilo-server` runtime before starting it. If that runtime has not been staged, Pilo reports the missing resource instead of silently using an incompatible binary.

## Custom themes

The desktop appearance settings offer **Lody** and **Claude**. To create or
edit a custom theme, open the theme settings in the connected WebUI. Both
clients use the active theme saved on the Host. See the [theme customization guide](docs/THEMES.md)
for examples and supported tokens, and the [desktop theme notes](desktop/README.md#custom-themes)
for native styling limitations.

## Images in replies

Ask Pi to save screenshots inside the project and include them in its reply using ordinary Markdown:

```markdown
Here is the current page:

![Page screenshot](./screenshots/page.png)

The button in the upper-right corner is misaligned.
```

Desktop and WebUI load project-relative images from the project's Local, WSL, or SSH environment. PNG, JPEG, WebP, and GIF are supported, up to 10 MB each; click an image to preview or save it. Absolute paths, parent-directory traversal, and SVG are not supported. HTTP(S) images also render inline and offer an Open original image action in a new tab instead of a direct download. No Pi plugin or core changes are required.

Images reference existing files, not immutable snapshots: deleting or overwriting a file can affect old replies. This feature does not add screenshot capture tools or automatically change Pi's prompts.

## Development

Run `pnpm hooks:install` once per clone to enable pre-commit checks. Every
commit runs `pnpm check` (frontend formatting and lint), then
`cargo fmt --all --check` (Rust formatting). Any failure blocks the commit;
files are not auto-formatted. TypeScript types, Rust workspace checks, Clippy,
full frontend builds and tests are checked outside this hook. CI still checks
TypeScript types through `pnpm build`.
Install the project's Node.js dependencies, Rust and the `nsh` CLI first.

The hook uses Git for Windows' bundled `sh` on Windows and the system `sh`
on macOS/Linux. Ensure `pnpm` and `cargo` are on the committing process's `PATH`.
Install Rust check components with `rustup component add rustfmt clippy`.
macOS needs Xcode Command Line Tools. Each checkout needs its own hook installation,
including separate Windows and WSL checkouts. Checks target the current host;
a WSL pass does not validate Windows or macOS code.

| Command                                                                | Purpose                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm check`                                                           | Run oxfmt format checks and oxlint                             |
| `pnpm format`                                                          | Format the frontend with oxfmt                                 |
| `pnpm build`                                                           | Type-check and build the frontend                              |
| `pnpm test`                                                            | Run Node unit and integration tests                            |
| `pnpm test:unit`                                                       | Run focused unit and static-rendering tests                    |
| `pnpm test:integration`                                                | Run CLI/process and Pi extension integration tests (Linux/WSL) |
| `cargo fmt --all --check`                                              | Check Rust formatting                                          |
| `cargo check --workspace --all-targets --all-features`                 | Check the Rust workspace                                       |
| `cargo test --workspace --all-features`                                | Run Rust workspace tests                                       |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Run Rust lints                                                 |
| `pnpm server:verify`                                                   | Verify the four bundled `pilo-server` release resources        |
| `cd desktop && nsh check` / `nsh test`                                 | Check / test the nsh desktop app and its Rust crate            |

Test layout, single-file commands and browser regression pages are documented
in [tests/README.md](tests/README.md). `pnpm test` does not include browser,
desktop or Rust tests.

## Repository layout

| Path                    | Contents                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `desktop/`              | nsh desktop app (TSX) and its Rust crate (`desktop/src`)                                                        |
| `web/`                  | React WebUI served by the desktop Host to browsers and phones                                                   |
| `shared/`               | Plain TypeScript shared by the desktop and the WebUI                                                            |
| `crates/pilo-runtime/`  | Host runtime: connections, projects, sessions, Pi RPC, Remote WebUI, SQLite indexes                             |
| `crates/pilo-domain/`   | Data models shared by the runtime and its shells                                                                |
| `crates/pilo-protocol/` | Wire protocol shared by the desktop app and `pilo-server`                                                       |
| `crates/pilo-server/`   | Pi streams, terminals, filesystem operations, preview ports, and session indexing inside the target environment |
| `scripts/`              | Runtime build and verification scripts                                                                          |
| `docs/`                 | Design notes                                                                                                    |

## Community

[linux.do](https://linux.do)

## Third-Party Notices

Some parts of Pilo are derived from third-party open-source software, including Lody. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for source and license details.

## License

Pilo is licensed under the [Apache License 2.0](./LICENSE).

Third-party source and attribution notices are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
