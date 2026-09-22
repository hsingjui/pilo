# Design — 桌面端日志模块

## Architecture & Boundaries

```
前端 (webview)
  console.error/warn ──attachConsole()──► @tauri-apps/plugin-log
                                              │ invoke log command
                                              ▼
桌面 Rust (pilo / src-tauri)
  log::error!/warn!  ─┐
                      ├─► tauri-plugin-log ─► app_data_dir()/logs/pilo*.log (轮转)
  远程 pilo-server     │        ▲
  stderr ──(已回流)────┘        │ (仅 Tauri 运行时，不覆盖 --version stdout 路径)
```

- 日志只在**桌面进程**落盘。远程 `pilo-server` 不新增日志依赖。
- `crates/pilo-server` 不属于本设计改动范围；其 stderr 已由 `src-tauri/src/runtime/server_client.rs` 回流到桌面 stderr（迁移后进入 `log`）。

## Contracts

- **路径契约**：日志目录 = `app.path().app_log_dir()`（Tauri 提供的 log 目录）；若与 `app_data_dir()` 不一致，以 `app_log_dir()` 为准（插件默认），并在 About 入口处用同一解析保持一致性。
- **文件名契约**：由插件默认命名（`<identifier>.log` 或带时间戳）；不自定义，减少维护面。
- **级别契约**：`LevelFilter` = debug 构建 `Debug`，release 构建 `Info`；通过 `cfg!(debug_assertions)` 选择。
- **subsystem 语义**：迁移 `eprintln!("[tag] ...")` → `log::error!(target: "tag", "...")`，保留可 grep 的 tag。
- **轮转契约**：`max_file_size(5 * 1024 * 1024)` + `RotationStrategy::KeepSome(5)`。
- **格式契约**：默认文本行；不引入 JSON 格式（避免与 spec 的“简单可读”冲突）。

## Data Flow

1. 插件在 `tauri::Builder` 注册，`setup` 之前完成，保证早期启动日志被捕获。
2. Rust 侧诊断点调用 `log` facade → 插件写入文件 + stdout（dev）。
3. 前端 `attachConsole()` 绑定 webview console → 经 IPC 调用日志命令 → 同一文件。
4. 远程会话：`server_client.rs` 读到 server stderr → 迁移后 `log::warn!` → 同一文件。

## Compatibility & Migration

- 新增依赖：`tauri-plugin-log`（src-tauri）、`@tauri-apps/plugin-log`（前端）。
- capabilities：`src-tauri/capabilities/default.json` 增加 `log:default`。
- 迁移 `eprintln!`：仅桌面 crate；`crates/pilo-server` 不动。
- 无数据结构/SQLite 变更；无向后兼容风险。
- `debug_trace` / `debug_chat_performance_log` 保持原样，避免行为回归。

## Trade-offs

- 选 `tauri-plugin-log` 而非 `tracing`：一次覆盖文件落盘 + 有界轮转 + 前端 `attachConsole`，代码量最小；代价是结构化查询能力弱（未来需要再评估 OTel）。
- 选“前端全量转发”而非逐点改写：58 处 `console.*` 零改动即被捕获；代价是需限制级别避免热路径刷屏。
- 不做远程独立落盘：桌面崩溃后远程日志会丢；但远程 stderr 已回流，MVP 可接受。

## Rollback

- 回滚点：移除插件注册 + 依赖 + capability，恢复 `eprintln!`（git revert 单 PR 即可）。
- 插件初始化失败不得 panic 阻塞启动：以 best-effort 注册，失败时退回 stderr（保留 `eprintln!` 兜底分支）。

## Operational Notes

- 日志目录随 app data 卸载策略；不做自动清理（由 KeepSome 有界）。
- 排查入口：About → 打开日志目录。
