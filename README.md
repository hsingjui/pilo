# Pilo

Pilo 是一个面向 Pi Coding Agent 的桌面工作区客户端，提供类似现代 IDE 的 Pi 使用体验。

## 功能

- 统一管理 Local / WSL / SSH 三种开发环境
- Workspace 与 Session 管理
- 通过 Pi RPC（`pi --mode rpc`）与 Pi 集成，Pi JSONL 是唯一事实来源
- Agent 工具调用与 Extension UI Bridge

## 技术栈

- Desktop: Tauri 2 + Rust 2024
- Frontend: React 19 + TypeScript + Vite + Tailwind CSS
- Backend: Tokio + Serde + tracing

## 开发

```bash
pnpm install
pnpm tauri dev
```

WSL 仅用于代码开发、构建检查和静态验证，桌面验证需在 Windows 侧执行。

前端检查：

```bash
pnpm check
```

Rust 检查：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
