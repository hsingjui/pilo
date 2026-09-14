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

- 开发环境：WSL (Debian)
- 运行目标：Windows Desktop
- WSL 仅用于代码开发、构建检查和静态验证。
- `pnpm tauri dev`、桌面窗口验证、安装包验证必须在 Windows 侧执行。

安装依赖前设置代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```

## Tech Stack

### Desktop

- Tauri 2
- Rust 2024

### Frontend

- React 19
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui 风格组件
- TanStack Query
- Zustand
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
React UI
    ↓
Tauri Commands / Events
    ↓
Pilo Runtime
    ↓
Connection Layer
    ↓
Pi RPC
    ↓
pi --mode rpc
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

## Development Guidelines

- 保持架构简单，避免过早抽象。
- UI 和 Runtime 分离。
- 不在 React 中直接调用系统能力。
- 不在 Tauri Command 中堆积业务逻辑。
- 新功能优先考虑是否适用于 Local/WSL/SSH 三种环境。
- 不复制 Pi 已有能力。

## Validation

修改前端：

```bash
pnpm format
pnpm check
pnpm build
```

其中 `pnpm format` 使用 oxfmt，`pnpm check` 执行 oxfmt 格式检查和 oxlint。

修改 Rust：

```bash
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

完整桌面验证（Windows）：

```bash
pnpm tauri dev
```
