# Pilo

Pilo 是一个面向 Pi Coding Agent 的桌面工作区客户端。

目标是提供类似现代 IDE 的 Pi 使用体验，并统一管理：

- Local 开发环境
- WSL 开发环境
- SSH 远程开发环境
- Pi Session
- Agent 工具调用
- 项目与工作区

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

### Workspace

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
Workspace
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

<comet-ambient-resume>
<!-- Managed by Comet. Edits inside this block may be replaced by comet init/update. -->
<!-- Contract: comet.resume_probe.v2 -->

## Comet Ambient Resume

在这个仓库中，开始处理需要改动或调查的任务前，如果可能存在活跃 Comet workflow，把当前用户请求传入只读探针：`comet resume-probe . --stdin --json`。

- 如果用户通过宿主明确调用任意 Comet Skill（例如 `@comet`、`/comet`、`@comet-native` 或 `/comet-hotfix`），显式调用优先于本恢复协议；不要运行 resume probe，直接进入被调用的 Skill。
- 如果用户通过宿主明确调用的是非 Comet 的 Skill 或斜杠命令，任务意图已由该调用明确：不要运行 resume probe，直接执行该 Skill。
- 如果你正在 Comet 流程内（包括正在等待用户回复你在流程中提出的问题），不要运行 resume probe；把这类回复（例如方案/选项选择）当作当前 change 的继续，直接按用户的选择推进。
- 只信任返回的 `workflow`、`skill` 和 `entrySource`；它们只由项目配置或无配置兼容回退决定。不得扫描或切换另一套 workflow。
- 如果 probe 返回 `auto_resume`，简短说明选中的 active change，并进入 `nextCommand` 指向的永久入口。不要把状态命令当作恢复入口直接推进。
- 如果 probe 返回 `ask_user`，只问一个简短问题并等待用户回复。
- 如果当前请求未明确调用 Comet Skill，且 probe 返回 `out_of_scope` 或 `none`，不要进入 Comet workflow。
- `out_of_scope` 或 `none` 只表示不要因为这个新请求进入 Comet workflow；它绝不表示要暂停或退出一个已在进行的 Comet 流程。
- 如果配置或状态无效且没有 `nextCommand`，停止并报告原因；不要猜测另一个 workflow。
- 不能只因为存在 active change 就把无关任务挂到该 change。Native 的未提交改动由 Native 入口检查，不由探针自动归因。
</comet-ambient-resume>
