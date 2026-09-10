# P0.2 Runtime Foundation — Implementation

## Status

Runtime Foundation 已在独立 Comet worktree `comet/runtime-foundation` 实现，等待 Comet Verify / Archive。该 worktree 从已提交的 `main` 基线创建，不读取或覆盖主工作区正在进行的 P0.1 UI Foundation 未提交文件。

## Runtime boundaries

```text
React UI
    ↓ invoke / listen
Tauri Commands / `pilo://runtime`
    ↓
PiloRuntime
    ↓
PiSession
    ↓
ProcessSpec + ManagedProcess
    ↓
stdin / stdout / stderr
```

### Tauri commands

- `runtime_get_pi_state`
- `runtime_spawn_pi`
- `runtime_stop_pi`
- `runtime_restart_pi`
- `runtime_abort_pi`
- `runtime_send_rpc`

`runtime_spawn_pi` 当前接收 `Connection + ProcessSpec`。这是 P0.2 的 transport seam；P0.3/P0.4/P0.5 在确定 Local / WSL / SSH 启动策略后，应由后端 transport/launch builder 构造 `ProcessSpec`，避免把环境分支散落进 `PiSession`。

### Runtime event

统一通过 `pilo://runtime` 发出 serde tagged event：

- `process_state`
- `rpc_message`
- `runtime_log`
- `runtime_error`

每个 process-scoped event 都携带 `generation`。

## Invariants

1. Pi RPC stdout 只进入 `JsonlCodec`，不会被当作日志处理。
2. stderr 不做 JSON decode，只转换为 `runtime_log`。
3. RPC framing 只以字节 LF (`0x0A`) 为边界；完整 frame 末尾允许剥离一个 CR (`0x0D`)。
4. 没有 LF 的尾部数据保持 buffered；进程 EOF 时若仍有尾部数据，发出 `rpc_framing` runtime error。
5. `abort` 写入 `{"type":"abort"}\n`，不会 kill process；`stop` 才终止 child process。
6. 每次成功或失败的 spawn attempt 都先分配新的单调递增 generation；restart 因重新 spawn 获得新 generation。
7. stdout/stderr reader 在发送应用事件前检查 active generation；旧 reader 的晚到事件会被丢弃。
8. 正常进程退出时先 drain stdout/stderr reader，再关闭 generation，避免把同一进程退出前已写入 pipe 的最终 RPC frame 误判为 stale；reader drain 有上限，避免被继承 pipe 的后代进程永久阻塞。
9. child process 启用 `kill_on_drop(true)`，即使 Tauri async runtime 在应用退出时直接丢弃 actor，也不会把 Pi 主进程遗留在后台。
10. 非零自然退出进入 `failed` 状态并发出 `process_exit` runtime error；显式 `stop` 独立处理，不会被误判成 crash。

## Verification

在 WSL Debian 中已执行：

```text
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Rust tests 共 11 项，覆盖：

- Local / WSL / SSH `ConnectionKind` serde tag。
- `ProcessSpec` program / args / cwd / env round-trip。
- Runtime event tagged serialization。
- strict LF framing、CRLF 尾部 CR、跨 chunk buffering、invalid JSON。
- generation 单调性和 stale event suppression。
- stop 与 actor 自然退出竞态：terminal state 已观察到时不误报 control-channel failure。
- Unix 真实子进程 lifecycle：spawn → abort JSONL → stdout RPC / stderr log 分流 → stop → restart。

Windows Tauri 窗口运行验证不属于本次 Runtime Foundation 的 WSL 静态验证范围；P0.3 接入真实 Local Pi 时再做端到端桌面验证。
