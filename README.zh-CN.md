<p align="center">
  <img src="./assets/branding/icon.png" width="128" alt="Pilo 应用图标">
</p>

<h1 align="center">Pilo</h1>

<p align="center">简洁的 Pi Coding Agent 桌面客户端：在一个工作区中管理 Local、WSL 与 SSH 项目，同时让 Pi 始终运行在代码所在的环境。</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/hsingjui/pilo/actions/workflows/ci.yml"><img src="https://github.com/hsingjui/pilo/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <img src="https://img.shields.io/badge/Desktop-Windows%20x64%20%7C%20macOS%20arm64-4B5563?style=flat-square" alt="桌面发行平台：Windows x64 与 macOS arm64">
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2024-3776AB?style=flat-square" alt="Rust 2024 edition"></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-3776AB?style=flat-square" alt="Tauri 2"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-3776AB?style=flat-square" alt="React 19"></a>
</p>

Pilo 是 [Pi Coding Agent](https://pi.dev/) 的桌面客户端，不重新实现 Agent。它负责在统一工作区中呈现 Connection、Project 与 Pi Session，而会话状态和 Agent 行为仍由 Pi 负责。

## 核心能力

| 能力                               | 为什么重要                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Local、WSL、SSH 统一工作区         | 项目保留在原本的环境中；Pilo 会在所选环境中运行 `pilo-server`，不需要先把远程项目复制到桌面端。       |
| Pi 运行在代码所在环境              | 服务端以项目目录为工作目录启动 `pi --mode rpc`，Local、WSL 与 SSH 使用一致的交互方式。                |
| Pi 保持事实来源                    | Session 直接读取 Pi 的 JSONL 文件；SQLite 只保存可重建的索引、缓存和桌面状态。                        |
| Chat、工具、终端、文件与 Diff 同窗 | Pilo 展示 Pi 的思考与工具调用，并整合 PTY 终端、文件操作、预览端口以及 Git 状态/Diff。                |
| 并行 Agent                         | 同一项目可以运行多个 Agent 流，并分别列出、发送消息或停止。                                           |
| 原生桌面更新                       | Release 构建会为 Windows x64 与 macOS arm64 生成 updater 产物，Pilo 可以从 GitHub Releases 检查更新。 |

## 架构

Pilo 由桌面应用和运行在目标 Connection 环境中的 `pilo-server` 组成。Local 直接运行，WSL 通过 `wsl.exe`，SSH 则向远端部署匹配平台的服务端二进制。桌面端与服务端通过 `crates/pilo-protocol` 定义的 protobuf `Envelope` 帧在 stdio 上通信。

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

## 快速安装

Pilo 当前以源码构建为主。开发需要 Node.js 22、pnpm（CI 使用 10.12.3）、Rust stable 工具链，以及在每个准备使用的环境中安装 Pi。

Pilo 默认从 `PATH` 自动发现 `pi`。也可以在 Settings 中为每个 Connection 单独指定 Pi 可执行文件路径。

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

上面的命令只会构建当前主机对应的 `pilo-server`。WSL 和 SSH Connection 还需要在 `src-tauri/resources/` 中准备与目标 OS/架构匹配的运行时；Release 打包流程会自动准备完整运行时集合。

支持的服务端运行时目标为 Linux x64/arm64、Windows x64/arm64 和 macOS x64/arm64。也可以显式构建指定目标：

```bash
bash scripts/build-pilo-server.sh <target>
```

## 快速开始

1. 使用 `pnpm tauri dev` 启动 Pilo。
2. 使用默认的 Local Connection，或添加 WSL / SSH Connection。
3. 如果 `pi` 不在 `PATH` 中，在 Settings 中为对应 Connection 指定 Pi 可执行文件路径并执行探测。
4. 添加项目目录并打开 Session。
5. 发送消息。Pilo 会在项目目录中启动 `pi --mode rpc`，并把会话流式呈现在工作区中。

对于 WSL 或 SSH，Pilo 会先探测目标平台并部署匹配的 `pilo-server` 运行时。如果对应运行时尚未准备，Pilo 会明确报告缺失的资源，而不是使用不兼容的二进制。

## 开发

| 命令                                                                   | 用途                                          |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| `pnpm check`                                                           | 运行 oxfmt 格式检查和 oxlint                  |
| `pnpm format`                                                          | 使用 oxfmt 格式化前端代码                     |
| `pnpm build`                                                           | TypeScript 类型检查并构建前端                 |
| `pnpm test:unit`                                                       | 运行前端单元测试                              |
| `cargo fmt --all --check`                                              | Rust 格式检查                                 |
| `cargo check --workspace --all-targets --all-features`                 | Rust workspace 检查                           |
| `cargo test --workspace --all-features`                                | Rust workspace 测试                           |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Rust lint                                     |
| `pnpm server:verify`                                                   | 校验发布所需的完整六平台 `pilo-server` 资源集 |

## 目录结构

| 路径                    | 内容                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `src/`                  | React UI：聊天、Session、侧边栏、设置、终端与项目交互               |
| `src-tauri/`            | Tauri 应用：命令、运行时管理、Connection/Project 状态与 SQLite 索引 |
| `crates/pilo-protocol/` | 桌面应用与 `pilo-server` 共用的通信协议                             |
| `crates/pilo-server/`   | 运行在目标环境中的 Pi 流、终端、文件系统、预览端口与 Session 索引   |
| `scripts/`              | 运行时构建与资源校验脚本                                            |
| `docs/`                 | 设计文档                                                            |

## 第三方开源声明

Pilo 的部分代码派生或改编自第三方开源软件，包括 Lody。来源与许可证详情见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 开源许可证

Pilo 使用 [Apache License 2.0](./LICENSE) 开源。

第三方代码来源与署名信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
