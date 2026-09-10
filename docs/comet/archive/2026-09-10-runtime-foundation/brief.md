# 目标

建立 Pilo P0.2 Runtime Foundation，使 React 与系统进程能力之间存在稳定的 Tauri Command / Event 边界，并为后续 Local / WSL / SSH Connection 提供统一的 Pi RPC 生命周期基础。

# 范围

- 建立 `Connection` domain model，覆盖 Local / WSL / SSH 三种连接类型，但不实现各连接的环境探测。
- 建立可复用 process execution abstraction，负责命令、cwd、环境、stdin/stdout/stderr 与子进程终止。
- 建立 `PiSession` 生命周期管理器，支持 spawn / stop / restart / abort。
- 建立 Pi RPC JSONL codec：严格以 LF (`\n`) 为 frame 边界；stdout 只进入 RPC codec；stderr 独立作为 runtime log event。
- 每次 spawn/restart 分配递增 generation id；异步 reader 产生的旧 generation event 在进入应用事件层前丢弃。
- 建立最小 Tauri commands 与 typed event payload，UI 不直接访问 process/system API。
- 为 codec、生命周期状态和 stale generation 规则添加 Rust 单元测试。

# 非目标

- 不实现 P0.3 的 Local Pi executable/version detection 或 workspace 环境信息。
- 不实现 P0.4 WSL distro 枚举与 `wsl.exe` transport。
- 不实现 P0.5 SSH transport。
- 不实现 Session SQLite/index/UI/chat rendering。
- 不修改当前 P0.1 UI Foundation 的 React UI、样式或组件。

# 验收示例

- A1: 存在稳定的 Tauri Command / Event 边界，React 不需要直接访问 process/system API。
- A2: `Connection` domain model 覆盖 Local / WSL / SSH，并与 PiSession 生命周期解耦。
- A3: 存在可复用 process execution abstraction，可配置 program/args/cwd/env 并以 piped stdin/stdout/stderr 启动子进程。
- A4: PiSession 支持 spawn / stop / restart / abort；abort 写入 RPC JSONL command，stop 才终止进程。
- A5: Pi RPC codec 严格仅按 LF (`\n`) 切 frame；CRLF 只在 frame 尾部移除可选 `\r`，没有 LF 的尾部数据保持 buffered。
- A6: stdout 只进入 RPC JSON decoder；stderr 只作为独立 runtime log event，不尝试 JSON 解码。
- A7: 每次 spawn/restart 生成递增 generation id，旧 process reader 晚到的 stale events 在应用事件层前被忽略。
- A8: Runtime 事件 payload 可序列化，至少覆盖 process state、RPC message、runtime log 和 runtime error。
- A9: `cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo test` 全部通过。

# 约束与不变量

- Pi JSONL stdout 是 RPC 数据通道，stderr 永远不混入 RPC。
- framing 只认 LF；不能使用 `lines()` 等会隐式接受其他边界语义的高层逻辑替代 codec。
- `PiSession` 是 runtime 业务层；Tauri command 只做参数转换、状态获取与调用。
- 不把 Local/WSL/SSH 特有分支散落到 PiSession；后续由 transport/process spec 构造层负责。
- 并发修改隔离在 Comet worktree `comet/runtime-foundation`，不覆盖 main 上 P0.1 未提交工作。

# 决策

- Runtime state 由 Tauri `State<PiloRuntime>` 持有，内部使用 Tokio `Mutex` 管理单个基础 Pi session；多 session registry 留到 Workspace/Session 阶段扩展。
- process abstraction 使用 `ProcessSpec` + `ManagedProcess`，基于 `tokio::process`；PiSession 只依赖该抽象暴露的 stdin 与生命周期。
- 对前端事件使用稳定字符串常量和 serde tagged payload，避免 UI 依赖 Rust 内部类型布局。
- generation 使用 `u64` 单调递增，只用于进程实例隔离，不作为持久化 session id。

# 待解决问题

- P0.3 确认 Pi RPC 的完整 command schema 后，可把当前通用 JSON command API 收紧为 typed Pi protocol commands。
- 多 Workspace / 多并行 Pi process 的 registry key 在 P0.6/P2.3 再确定。

# 验证预期

- `cargo fmt --all --check`
- `cargo check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test`
- 复核 diff 仅包含 runtime foundation、Comet artifacts 与必要依赖，不包含 P0.1 UI 文件。
