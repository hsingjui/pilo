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
  <img src="https://img.shields.io/badge/Desktop-macOS%20development-4B5563?style=flat-square" alt="桌面开发平台：macOS">
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2024-3776AB?style=flat-square" alt="Rust 2024 edition"></a>
  <a href="https://github.com/longbridge/nsh"><img src="https://img.shields.io/badge/nsh-0.7-3776AB?style=flat-square" alt="nsh 0.7"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-3776AB?style=flat-square" alt="React 19"></a>
</p>

Pilo 是 [Pi Coding Agent](https://pi.dev/) 的桌面客户端，不重新实现 Agent。它负责在统一工作区中呈现 Connection、Project 与 Pi Session，而会话状态和 Agent 行为仍由 Pi 负责。

## 核心能力

| 能力                               | 为什么重要                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Local、WSL、SSH 统一工作区         | 项目保留在原本的环境中；Pilo 会在所选环境中运行 `pilo-server`，不需要先把远程项目复制到桌面端。 |
| Pi 运行在代码所在环境              | 服务端以项目目录为工作目录启动 `pi --mode rpc`，Local、WSL 与 SSH 使用一致的交互方式。          |
| Pi 保持事实来源                    | Session 直接读取 Pi 的 JSONL 文件；SQLite 只保存可重建的索引、缓存和桌面状态。                  |
| Chat、工具、终端、文件与 Diff 同窗 | Pilo 展示 Pi 的思考与工具调用，并整合 PTY 终端、文件操作、预览端口以及 Git 状态/Diff。          |
| 并行 Agent                         | 同一项目可以运行多个 Agent 流，并分别列出、发送消息或停止。                                     |

## 架构

Pilo 由桌面应用和运行在目标 Connection 环境中的 `pilo-server` 组成。Local 直接运行，WSL 通过 `wsl.exe`，SSH 则向远端部署匹配平台的服务端二进制。桌面端与服务端通过 `crates/pilo-protocol` 定义的 protobuf `Envelope` 帧在 stdio 上通信。

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

## 快速安装

Pilo 当前以源码构建为主。开发需要 Node.js 22、pnpm（CI 使用 10.12.3）、Rust stable 工具链，以及在每个准备使用的环境中安装 Pi。

Pilo 默认从 `PATH` 自动发现 `pi`。也可以在 Settings 中为每个 Connection 单独指定 Pi 可执行文件路径。

桌面端基于 [nsh](https://github.com/longbridge/nsh) 构建。在 macOS、Windows、Linux 上使用相同的开发启动命令，需将 `nsh` 0.7.2 CLI 加入 `PATH`。桌面端目前只在 macOS 上验证。

```bash
pnpm install
pnpm dev          # 启动 nsh 桌面端并监听 WebUI 改动
```

`pnpm dev` 在启动桌面端前构建本机 debug 版 `pilo-server`、`pilo-cli` 和 WebUI 的 `dist/`。macOS/Linux 可直接运行 `target/debug/pilo`，Windows 可运行 `target/debug/pilo-cli-bin/pilo-dev.exe`。将 `PILO_SERVER_BINARY` 或 `PILO_CLI_BINARY` 设为已有可执行文件的绝对路径，可跳过对应二进制的构建。

WebUI 改动只会重建 `dist/`，不会重新编译 Rust 二进制。只跑独立 WebUI 用 `pnpm dev:web`，它不提供 Pilo Host API。

若直接在仓库根目录运行 `nsh dev`，请先用 `cargo build -p pilo-server` 构建本机 server。WSL/SSH 请先为远程目标构建开发 server，再启动或重启 Pilo：

```bash
pnpm server:build
```

Windows 请在 Windows 那份仓库中执行以上命令。手动构建通过 WSL 运行，WSL 中需安装 Rust 和 Bash，默认构建该发行版原生架构的 Linux server。可在构建前指定发行版，例如 `$env:PILO_DEV_WSL_DISTRO = "Debian"`。macOS/Linux 默认构建原生 server。其他远程目标可使用 `pnpm server:build linux-aarch64`，构建环境中需安装对应 Rust target 和链接器。

dev 构建默认使用一个 Cargo job，并关闭调试符号，降低 WSL 内存占用；需要时可显式覆盖 `CARGO_BUILD_JOBS` / `CARGO_PROFILE_DEV_DEBUG`。正式构建参数不变。

开发二进制直接使用 Cargo 标准输出目录，例如 `target/x86_64-unknown-linux-gnu/debug/pilo-server`，不再额外复制一份；`resources/` 中的正式资源保持不变。启动或连接时，Pilo 将匹配的 server 部署到 dev 运行目录，server 自动将内嵌插件释放到 `extensions/`。修改插件后重新构建并重启 Pilo/Pi 即可加载。运行时和插件缓存使用 `pilo-dev/server`，而非正式版的 `pilo/server`（WSL/SSH 为 `~/.cache/pilo-dev/server`）；Pi 设置和会话文件仍然共享。

在 GitHub **Actions → Release → Run workflow** 选择分支，可以手动构建 nsh 发布包；匹配版本的 tag 才会创建 Release 草稿。见[桌面端打包说明](desktop/README.md#release-builds)。独立的 server 运行时流水线构建四个随包分发的目标。手动准备正式资源时，Windows 使用 `pnpm server:build:win`，macOS/Linux 使用 `bash scripts/build-pilo-server.sh`。

支持的服务端运行时目标为 Linux x64/arm64、Windows x64/arm64 和 macOS x64/arm64。也可以显式构建指定目标：

```bash
bash scripts/build-pilo-server.sh <target>
```

## 快速开始

1. 在仓库根目录运行 `pnpm dev` 启动 Pilo 和 WebUI 开发服务。
2. 使用默认的 Local Connection，或添加 WSL / SSH Connection。
3. 如果 `pi` 不在 `PATH` 中，在 Settings 中为对应 Connection 指定 Pi 可执行文件路径并执行探测。
4. 添加项目目录并打开 Session。
5. 发送消息。Pilo 会在项目目录中启动 `pi --mode rpc`，并把会话流式呈现在工作区中。

对于 WSL 或 SSH，Pilo 会先探测目标平台并部署匹配的 `pilo-server` 运行时。如果对应运行时尚未准备，Pilo 会明确报告缺失的资源，而不是使用不兼容的二进制。

## 自定义主题

桌面端外观设置提供 **Lody** 和 **Claude**。要创建或编辑自定义主题，请打开已连接 WebUI 的主题设置。
两端都使用 Host 保存的当前主题。入门示例及可用令牌见[主题编写指南](docs/THEMES.md)，桌面样式限制见[桌面主题说明](desktop/README.md#custom-themes)（均为英文）。

## 回复中的图片

让 Pi 将截图保存在项目目录内，并在回复中使用普通 Markdown 引用：

```markdown
这是当前页面：

![页面截图](./screenshots/page.png)

右上角的按钮存在对齐问题。
```

桌面端和 WebUI 会从项目所在的 Local、WSL 或 SSH 环境加载相对路径图片。支持 PNG、JPEG、WebP、GIF，单张不超过 10 MB；点击图片可放大预览或保存。不支持绝对路径、父目录跳转和 SVG，普通 HTTP(S) 图片也能嵌入正文，预览中提供“打开原图”的新标签页入口，不直接下载。无需 Pi 插件或修改 Pi 核心。

图片引用现有文件，不是不可变快照：删除或覆盖文件可能影响旧回复。这项功能不会增加截图工具，也不会自动修改 Pi 的提示词。

## 开发

每次克隆后运行一次 `pnpm hooks:install`，启用提交前检查。每次提交会依次执行
`pnpm check`（前端格式和 lint）、`pnpm exec tsc --noEmit`（TypeScript 类型检查），
再执行 Rust 格式检查、workspace 检查和 Clippy；任何一步失败都会阻止提交，
不会自动格式化文件。钩子不执行完整前端构建或测试。需要先安装项目的 Node.js
依赖、Rust 和 `nsh` CLI。

钩子在 Windows 使用 Git for Windows 自带的 `sh`，macOS/Linux 使用系统 `sh`。
提交进程的 `PATH` 中需有 `pnpm` 和 `cargo`，并通过 `rustup component add rustfmt clippy`
安装检查组件。macOS 需要 Xcode Command Line Tools。每份仓库均需单独启用钩子，包括 Windows
和 WSL 的两份仓库。检查针对当前宿主平台，WSL 通过不代表 Windows 或 macOS 通过。

| 命令                                                                   | 用途                                         |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| `pnpm check`                                                           | 运行 oxfmt 格式检查和 oxlint                 |
| `pnpm format`                                                          | 使用 oxfmt 格式化前端代码                    |
| `pnpm build`                                                           | TypeScript 类型检查并构建前端                |
| `pnpm test`                                                            | 运行 Node 单元测试和集成测试                 |
| `pnpm test:unit`                                                       | 运行单元测试和静态渲染测试                   |
| `pnpm test:integration`                                                | 运行 CLI/进程及 Pi 扩展集成测试（Linux/WSL） |
| `cargo fmt --all --check`                                              | Rust 格式检查                                |
| `cargo check --workspace --all-targets --all-features`                 | Rust workspace 检查                          |
| `cargo test --workspace --all-features`                                | Rust workspace 测试                          |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Rust lint                                    |
| `pnpm server:verify`                                                   | 校验随包分发的四个 `pilo-server` 发布资源    |
| `cd desktop && nsh check` / `nsh test`                                 | 检查 / 测试 nsh 桌面应用及其 Rust crate      |

测试目录、单文件运行命令及浏览器回归页面见 [tests/README.md](tests/README.md)。
`pnpm test` 不包含浏览器、桌面端或 Rust 测试。

## 目录结构

| 路径                    | 内容                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `desktop/`              | nsh 桌面应用（TSX）及其 Rust crate（`desktop/src`）               |
| `web/`                  | 桌面 Host 提供给浏览器和手机的 React WebUI                        |
| `shared/`               | 桌面端与 WebUI 共用的纯 TypeScript                                |
| `crates/pilo-runtime/`  | Host 运行时：连接、项目、会话、Pi RPC、Remote WebUI、SQLite 索引  |
| `crates/pilo-domain/`   | 运行时与壳共用的数据模型                                          |
| `crates/pilo-protocol/` | 桌面应用与 `pilo-server` 共用的通信协议                           |
| `crates/pilo-server/`   | 运行在目标环境中的 Pi 流、终端、文件系统、预览端口与 Session 索引 |
| `scripts/`              | 运行时构建与资源校验脚本                                          |
| `docs/`                 | 设计文档                                                          |

## 社区

[linux.do](https://linux.do)

## 第三方开源声明

Pilo 的部分代码派生或改编自第三方开源软件，包括 Lody。来源与许可证详情见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 开源许可证

Pilo 使用 [Apache License 2.0](./LICENSE) 开源。

第三方代码来源与署名信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
