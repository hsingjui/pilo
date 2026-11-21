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

- 当前在 macOS 上开发和验证桌面端；Windows / Linux 桌面、WSL 与打包验证延后（见迁移规则）。

安装依赖前设置代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```

## 迁移过渡期

Tauri 壳已移除，桌面端只剩 nsh 版本。平台范围、两端修改归属与逐功能测试提交要求，统一见 [nsh 迁移协作规则](.trellis/spec/desktop/quality-guidelines.md#迁移协作规则)；完整入口为 [nsh 规范](.trellis/spec/desktop/index.md)和[功能对齐清单](.trellis/tasks/11-19-nsh-desktop-migration/feature-parity.md)。

## Directory Layout

```text
crates/pilo-protocol/   Pilo ↔ pilo-server 的 protobuf 线协议
crates/pilo-server/     运行在代码所在环境的 server 与 Pi 扩展
crates/pilo-domain/     纯数据模型与校验
crates/pilo-runtime/    Host 运行时：连接、项目、会话、Pi RPC、Remote WebUI
desktop/                nsh 桌面应用（TSX），本身也是 Rust crate（desktop/src，"rust": "."）
web/                    React WebUI（浏览器 / 移动端）
shared/                 两端共用的纯 TypeScript（`@shared/*`）
resources/              pilo-server 各平台产物（不入库）
```

依赖方向：`desktop`、`web` → `shared`；`desktop/src` → `pilo-runtime` → `pilo-domain` / `pilo-server` → `pilo-protocol`。`shared/` 只写纯 TypeScript（`tsc -p shared` 与 oxlint 把关），`web` 与 `desktop` 互不导入。

## Tech Stack

### Desktop

- nsh 0.6.1（TSX 界面 + Rust 原生模块）
- Rust 2024

### WebUI

- React 19
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui 风格组件
- oxfmt
- oxlint

### Backend

- Tokio
- Serde
- tracing

### Pi Integration

- Pi RPC (`pi --mode rpc`)
- JSONL streaming
- Extension UI Bridge

## Architecture

```text
nsh desktop (desktop/)            React WebUI (web/)
    ↓ app/native (desktop/src)        ↓ HTTP / WebSocket
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

Pilo 有两套 UI 入口，各自实现界面、共用 `shared/` 里的逻辑：

- **桌面端** — nsh 应用，`desktop/`。
- **WebUI** — React，`web/`（入口 `web/remote/`），浏览器访问的远程界面。

用户可见的功能改动默认两端都要做；与界面无关的逻辑（类型、状态推导、协议解析、格式化）放进 `shared/`，两端直接导入，不要各写一份。

WebUI 的移动端适配是必需项：窄屏布局、足够大的触控目标、安全区（safe-area）、软键盘 inset、viewport 行为。

## Development Guidelines

- 保持架构简单，避免过早抽象。
- UI 和 Runtime 分离：业务逻辑放 `crates/pilo-runtime`，`desktop/src` 只做参数转换和壳能力（路径、事件、资源、文件选择）。
- 新功能优先考虑是否适用于 Local/WSL/SSH 三种环境。
- 不复制 Pi 已有能力。

## Validation

修改 WebUI / shared：

```bash
pnpm format
pnpm check
pnpm build
pnpm test
```

`pnpm check` 执行 oxfmt 格式检查和 oxlint；`pnpm build` 先跑 `tsc -p shared`（无 DOM 的纯 TS 检查）。

修改 Rust：

```bash
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

修改桌面端（含 `desktop/src` 和被它用到的 `shared/`）：

```bash
cd desktop
nsh check
nsh test
```

## Release

nsh 版发版流程尚未建立（原 Tauri release workflow 已删除）。发布新版本前，必须先向用户确认目标版本号；`Cargo.toml` 的 `[workspace.package].version`、`Cargo.lock` 中 workspace 包版本与 tag 必须一致。

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
