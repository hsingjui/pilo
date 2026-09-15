<p align="center">
  <img src="./icon.png" width="128" alt="Pilo 应用图标">
</p>

<h1 align="center">Pilo</h1>

<p align="center">面向 Pi Coding Agent 的桌面工作区客户端：在一个窗口中管理 Local、WSL 与 SSH 项目，同时让 Pi 始终运行在代码所在的环境。</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

Pilo 是 <a href="https://pi.dev/">Pi Coding Agent</a> 的桌面客户端，不重新实现 Agent。它把 Connection、Project、Session 与终端放进统一工作区，并通过 Pi 的 RPC 模式驱动实际 Agent 进程。

## 核心能力

| 能力 | 为什么重要 |
| --- | --- |
| Local、WSL、SSH 统一工作区 | 项目保留在原本的环境中；Pilo 为对应连接启动或部署 `pilo-server`，不需要先把远程项目复制到桌面端。 |
| Pi 运行在代码所在环境 | `pilo-server` 以项目目录为工作目录启动 `pi --mode rpc`，Local、WSL 与 SSH 使用同一套交互模型。 |
| Pi Session 保持事实来源 | Pilo 围绕 Pi 的 Session 与 JSONL 数据工作，而不是维护一套独立的对话格式。 |
| 集成终端与运行环境能力 | `pilo-server` 提供 PTY 终端、文件操作与预览端口探测等能力，操作发生在项目实际所在的环境。 |
| 独立运行时部署 | WSL 与 SSH 会根据目标 OS/架构选择对应的 `pilo-server` 运行时并部署到目标环境。 |

## 架构

Pilo 分为桌面应用与连接环境中的 `pilo-server`。桌面端负责 UI、Connection 与 Project 管理；`pilo-server` 负责在目标环境中访问文件、终端和 Pi。WSL 通过 `wsl.exe` 启动服务端，SSH 则部署并远程启动匹配目标平台的服务端二进制。

```text
┌──────────────────────────────┐
│        Pilo Desktop          │
│       React + Tauri          │
└──────────────┬───────────────┘
               │ pilo-protocol / stdio
               ▼
┌──────────────────────────────┐
│          pilo-server         │
│ Local | WSL | SSH environment│
└──────────────┬───────────────┘
               │ pi --mode rpc
               ▼
┌──────────────────────────────┐
│       Pi Coding Agent        │
└──────────────────────────────┘
```

## 快速安装

当前仓库以源码构建为主。开发前需要：

- Node.js 与 pnpm
- Rust stable 工具链
- 在每个要使用的环境中安装并完成 Pi 的认证
- Pi 可执行文件 `pi` 能从该环境的 `PATH` 中找到

Pi 官方安装与认证说明见 [Pi Quickstart](https://pi.dev/docs/latest/quickstart)。

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

`server:build` / `server:build:win` 只准备当前主机对应的 `pilo-server`。如果开发时要连接不同 OS 或架构的 WSL/SSH 环境，还需要在 `src-tauri/resources/` 中准备目标环境匹配的运行时。

仓库的 `Server runtimes` GitHub Actions 工作流会构建完整的六个平台运行时：Linux x64/arm64、Windows x64/arm64、macOS x64/arm64。也可以使用 `scripts/build-pilo-server.sh <target>` 显式构建受支持的目标。

## 快速开始

1. 确认目标环境中的 `pi` 已安装、已认证，并且可从 `PATH` 找到。
2. 使用上面的命令启动 Pilo。
3. 选择 Local、WSL 或 SSH Connection，并添加项目目录。
4. 打开项目 Session 并发送消息。Pilo 会在该项目目录中启动 `pi --mode rpc` 并把事件流呈现在桌面界面中。

如果 WSL 或 SSH 的目标平台缺少对应 `pilo-server` 运行时，Pilo 会在部署阶段报告缺失的运行时文件；这时需要先构建或准备对应目标的资源。

## 开发

| 命令 | 用途 |
| --- | --- |
| `pnpm check` | oxfmt 格式检查与 oxlint |
| `pnpm format` | 使用 oxfmt 格式化前端代码 |
| `pnpm build` | TypeScript 类型检查并构建前端 |
| `pnpm test:unit` | 前端单元测试 |
| `cargo fmt --all --check` | Rust 格式检查 |
| `cargo check --workspace --all-targets --all-features` | Rust workspace 检查 |
| `cargo test --workspace --all-features` | Rust workspace 测试 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Rust lint |
| `pnpm server:verify` | 校验发布所需的完整六平台 `pilo-server` 资源集 |

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/` | React 前端与桌面交互界面 |
| `src-tauri/` | Tauri 应用、Connection/Project 管理与桌面运行时 |
| `crates/pilo-protocol/` | 桌面端与 `pilo-server` 共享的通信协议 |
| `crates/pilo-server/` | 运行在目标环境中的 Pi、终端、文件系统与 Session 服务 |
| `scripts/` | `pilo-server` 构建与资源校验脚本 |
| `docs/` | 项目设计文档 |
