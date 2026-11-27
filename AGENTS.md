# Pilo

Pilo 是一个面向 Pi Coding Agent 的桌面工作区客户端。

目标是提供类似现代 IDE 的 Pi 使用体验，并统一管理：

- Local 开发环境
- WSL 开发环境
- SSH 远程开发环境
- Pi Session
- Agent 工具调用
- 项目

Pilo 不重新实现 Agent 能力，而是作为 Pi 的桌面入口。

## Environment

- 当前在 macOS 上开发和验证桌面端；Windows / Linux 桌面、WSL 与打包验证延后。

安装依赖前设置代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```

## Directory Layout

```text
nsh.json                桌面端 nsh 主配置（"rust": "crates/pilo-desktop"）
App.tsx                 桌面端入口（根目录直接运行 nsh dev / check / test / package）
crates/pilo-protocol/   Pilo ↔ pilo-server 的 protobuf 线协议
crates/pilo-server/     运行在代码所在环境的 server 与 Pi 扩展
crates/pilo-domain/     纯数据模型与校验
crates/pilo-runtime/    Host 运行时：连接、项目、会话、Pi RPC、Remote WebUI 服务
crates/pilo-desktop/    桌面端 Rust 原生模块（app/native，独立 workspace）
app/                    桌面端外壳（shell/、settings/）与两端共用 nsh UI（chat/、composer/、state/、ui/、tests/）
web/                    Remote WebUI（nsh Web 入口、配对页、远程客户端、移动端壳）
shared/                 纯 TypeScript 领域逻辑与协议（`@shared/*`，无 nsh/DOM）
theme/                  内置主题源 CSS 与生成的 theme.json / claude-theme.json
scripts/                构建、代码生成与开发脚本
tests/                  Node 单元测试与集成测试（*.spec.ts / *.spec.mjs）
resources/              pilo-server 各平台产物（不入库）
```

依赖方向：`App.tsx` / `app/`、`web/` → `shared/`；`crates/pilo-desktop` → `pilo-runtime` → `pilo-domain` / `pilo-server` → `pilo-protocol`。`shared/` 只写纯 TypeScript（`tsc -p shared` 与 oxlint 把关）。

## Tech Stack

### UI (Desktop & Remote WebUI)

- nsh 0.7.2（TSX 界面，Desktop 走原生宿主，Remote WebUI 走 `nsh package --target web`）
- TypeScript / oxfmt / oxlint

### Backend

- Rust 2024
- Tokio / Axum / Serde / tracing

### Pi Integration

- Pi RPC (`pi --mode rpc`)
- JSONL streaming
- Extension UI Bridge

## Architecture

```text
nsh Desktop (App.tsx + app/)       nsh Remote WebUI (web/)
    ↓ app/native (crates/pilo-desktop)   ↓ HTTP / WebSocket
            Pilo Runtime (crates/pilo-runtime)
                    ↓
            Connection Layer
                    ↓
         pilo-server → Pi RPC → pi --mode rpc
```

## Core Concepts

### Connection

表示 Pi 运行环境：

- Local
- WSL
- SSH

### Project

表示开发目录：

- 项目路径
- Git 状态
- 环境信息

### Session

Pi Session 由 Pi 管理。

原则：

- Pi JSONL 是唯一事实来源。
- SQLite 只作为桌面端索引和缓存。
- 不复制完整 conversation 数据。

## Remote Development

远程开发是核心能力。

支持：

```text
Pilo
 ↓
Connection
 ↓
Local / WSL / SSH
 ↓
Project
 ↓
Pi RPC
```

不要把远程项目同步到本地。

Pi 应该运行在代码所在环境。

## UI

Pilo 桌面端与 Remote WebUI 均基于 nsh 实现，共用 `app/` 里的对话/输入/状态/基础组件与 `shared/` 里的纯 TypeScript 逻辑：

- **桌面端** — 仓库根 `nsh.json` + `App.tsx` + `app/`。
- **Remote WebUI** — `web/`（独立 `web/nsh.json`，`web.base: "/"`），构建产出到 `dist/`，由 `crates/pilo-runtime` 直接在 `/` 提供静态服务与 `/pair` 扫码配对。

Remote WebUI 的移动端适配是必需项：窄屏布局、足够大的触控目标、安全区（safe-area）、软键盘 inset、viewport 行为。

## Development Guidelines

- 保持架构简单，避免过早抽象。
- UI 和 Runtime 分离：业务逻辑放 `crates/pilo-runtime`，`crates/pilo-desktop` 只做参数转换和壳能力（路径、事件、资源、文件选择）。
- 新功能优先考虑是否适用于 Local/WSL/SSH 三种环境。
- 不复制 Pi 已有能力。

## Validation

修改 TypeScript / shared / scripts：

```bash
pnpm format
pnpm check
pnpm test
pnpm build
pnpm generate:themes --check
pnpm generate:icons --check
```

修改 Rust：

```bash
cargo fmt --all --check
cargo fmt --manifest-path crates/pilo-desktop/Cargo.toml --all --check
cargo check --workspace --all-targets --all-features
cargo check --manifest-path crates/pilo-desktop/Cargo.toml --all-targets
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo clippy --manifest-path crates/pilo-desktop/Cargo.toml --all-targets -- -D warnings
cargo test -p pilo-domain -p pilo-runtime
cargo test --manifest-path crates/pilo-desktop/Cargo.toml
```

修改 nsh 应用（桌面端 & WebUI）：

```bash
nsh check
nsh test
```

## Release

发布新版本前，必须先向用户确认目标版本号。手动打包、版本一致性与 tag 发版见 [nsh 发版说明](app/README.md#release-builds)。

<!-- TRELLIS:START -->

# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:

- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
