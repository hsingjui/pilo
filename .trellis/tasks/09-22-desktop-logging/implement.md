# Implement — 桌面端日志模块

## 前置阅读

- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/error-handling.md`
- `.trellis/spec/frontend/hook-guidelines.md`（前端入口改动参考）

## Checklist（有序）

1. **依赖**
   - `src-tauri/Cargo.toml`：加 `tauri-plugin-log = "2"`。
   - `package.json`：加 `@tauri-apps/plugin-log`（^2）。
2. **后端插件注册**（`src-tauri/src/lib.rs`，约 69–88 行的 Builder 链）
   - `.plugin(tauri_plugin_log::Builder::new() ...build())`，配置 level / max_file_size(5MiB) / KeepSome(4) / targets；Webview target 过滤前端 `webview::*` 日志，避免回显循环。
   - 确认在 `setup`（约 174 行）之前注册。
3. **capabilities**（`src-tauri/capabilities/default.json`）：permissions 增加 `log:default` 与 `opener:allow-open-path`。
4. **迁移 eprintln**（保留 `[tag]` 作为 target）
   - `src-tauri/src/lib.rs`（3 处：约 195/204/217）
   - `src-tauri/src/desktop_notifications.rs`（9 处）
   - `src-tauri/src/runtime/server_client.rs`（1 处）
   - `src-tauri/src/runtime/events.rs`（1 处）
5. **前端转发**（`src/main.tsx`）：注册单一 `attachLogger()` 监听器并通过原始 console 方法回放后端日志；包装 `console.error/warn` 调用插件 `error/warn` API；不转发 `console.log`。Rust Webview target 过滤 `webview::*` 来源，使前端日志只落盘、不回显。
6. **About 入口**（`src/components/settings/about-settings.tsx`）：加“打开日志目录”，用 `opener` 打开日志目录；路径解析与插件一致（`appLogDir()` 或新增后端命令，二选一，优先直接用 JS `appLogDir()` API）。
7. **spec 更新**：改写 `.trellis/spec/backend/logging-guidelines.md`，说明框架已引入、新约定、迁移后的调用方式。

## Validation

Rust：

```bash
cd src-tauri && cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

前端：

```bash
pnpm format
pnpm check
pnpm build
```

桌面实机（Windows 侧）：

```bash
pnpm tauri dev
```

验证 AC1–AC6（release 落盘、前端转发、远程日志、轮转、脱敏、打开目录）。

## Risky Files / Rollback Points

- `src-tauri/src/lib.rs`：Builder 链与 setup 顺序；插件注册失败不得阻塞启动。
- `src/main.tsx`：顶层副作用会影响启动；`attachLogger()` 需容错（非 Tauri 环境/失败时不抛），且回放必须调用原始 console 方法。
- `src-tauri/capabilities/default.json`：权限名必须与插件版本匹配。
- 每步可独立回滚；整体可用一次 `git revert` 撤销。

## Follow-up Checks before `task.py start`

- 确认 `tauri-plugin-log` v2 的 `RotationStrategy::KeepSome` 与 `LevelFilter` 实际 API 签名。
- 确认 `attachLogger()` 的级别回放方式（避免把前端 `console.log` 带入持久化热路径）。
- 确认 `app_log_dir()` 在 Windows/WSL/SSH 目标下的实际路径。

## Notes

- 子代理已禁用（inline 模式），`implement.jsonl` / `check.jsonl` 无需填充。
