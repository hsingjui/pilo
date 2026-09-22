# 新增桌面端日志模块

## Goal

让 Pilo 桌面端具备“可留存、可排查”的日志能力，覆盖桌面 Rust runtime 与前端错误。
核心痛点：release 版 Windows 程序带 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`（`src-tauri/src/main.rs:2`），无 console，现有 `eprintln!` 诊断全部丢弃；`debug_trace`（`src-tauri/src/runtime/debug_trace.rs`）整段被 `#[cfg(debug_assertions)]` 关闭，发布版零留痕。

## Background（仓库证据）

- 现有诊断全部为 `eprintln!("[subsystem] ...")`，只写 stderr，不落盘。
- 无日志框架；`.trellis/spec/backend/logging-guidelines.md` 明确要求“未经项目决策不得引入框架”——本任务即该决策。
- 远程 `pilo-server` stderr 已由 `src-tauri/src/runtime/server_client.rs` 读出并回流到桌面 stderr，因此桌面日志落盘即可覆盖远程日志，无需远程侧独立落盘。
- 前端仅 `console.error/warn`（58 处），devtools 可见、不持久。
- `app_data_dir` 解析已存在于 `src-tauri/src/runtime/storage/schema.rs:22`（当前为私有函数）。
- 设置页存在 About 页 `src/components/settings/about-settings.tsx`，可承载“打开日志目录”入口；`opener` 插件已注册。

## Requirements

- R1 引入 `tauri-plugin-log`（Rust）+ `@tauri-apps/plugin-log`（JS），在 `src-tauri/src/lib.rs` 的 `tauri::Builder`（约 69–88 行）注册。
- R2 日志落盘到 `app_data_dir()/logs/`，单文件上限 5 MB，使用 `RotationStrategy::KeepSome(5)` 做有界轮转。
- R3 级别：release 默认 `Info`，dev 默认 `Debug`；不提供运行时 UI 开关。
- R4 迁移桌面端 `eprintln!` 为 `log` facade（`log::error!/warn!`），保留 `[subsystem]` 语义作为 log target：`src-tauri/src/lib.rs`(3)、`src-tauri/src/desktop_notifications.rs`(9)、`src-tauri/src/runtime/server_client.rs`(1)、`src-tauri/src/runtime/events.rs`(1)。
- R5 前端在 `src/main.tsx` 调用 `attachConsole()`，将 webview 的 `console.error/warn` 转发进同一日志文件。
- R6 About 设置页增加“打开日志目录”入口，复用已注册的 `opener` 插件。
- R7 `src-tauri/capabilities/default.json` 增加 `log:default` 权限。
- R8 遵守 `logging-guidelines.md`：不得记录密钥/凭据/SSH 密码/keyring 值/完整会话 JSONL；热路径不得刷屏。
- R9 同步更新 `.trellis/spec/backend/logging-guidelines.md`，反映框架已引入后的新约定。

## Acceptance Criteria

- [ ] AC1 release 构建运行后，`app_data_dir()/logs/` 下存在日志文件，且包含启动/后台任务失败记录。
- [ ] AC2 前端触发一次 `console.error` 后，可在日志文件中看到对应转发记录。
- [ ] AC3 运行一次 WSL 或 SSH 远程会话，日志文件中出现 `[pilo-server:...]` 诊断。
- [ ] AC4 日志超过 5 MB 后自动轮转，磁盘占用有界（≤ 约 25 MB）。
- [ ] AC5 日志内容不含密钥/凭据/完整会话内容。
- [ ] AC6 About → 打开日志目录可正确定位到 `app_data_dir()/logs/`。

## Out of Scope

- 远程侧独立落盘（选定方案 A，不选远程文件方案）。
- `crates/pilo-server` 的 `println!`：`crates/pilo-server/src/main.rs` 中 `--version/--fingerprint` 属 stdout 协议通道，禁止迁移；server 侧继续用 stderr 诊断。
- 重构现有 `debug_trace` / `debug_chat_performance_log`（保持 dev 专用 opt-in）。
- 日志查看 UI、级别的用户可配开关。
- 结构化日志 / OpenTelemetry。

## Notes

- 关键决策：范围=桌面 Rust + 前端转发；框架=`tauri-plugin-log`。
- 实现时需确认：`attachConsole()` 是否会把 webview 高频 `console.log` 也带入（需限制为 error/warn）；`KeepSome` 的保留语义以实际版本为准。
