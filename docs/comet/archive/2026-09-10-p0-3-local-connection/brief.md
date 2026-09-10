# 目标

实现 Pilo P0.3 Local Connection，让桌面端能够在本机环境中发现并验证 Pi，可针对指定 Workspace 启动 `pi --mode rpc`，并向上层提供 cwd、Git branch、Pi version 等本地环境信息以及可区分的启动/运行错误。

# 范围

- 完善 Local Connection 数据模型与本地环境信息结构。
- 检测本机 `pi` 可执行文件，并返回可用于诊断的路径/缺失状态。
- 执行 Pi 版本探测并解析版本文本。
- 针对指定 Workspace 生成 Local Pi RPC 启动配置，工作目录必须是目标 Workspace。
- 生产启动保持 Pi 正常 extension 加载语义，不传 `--no-extensions`。
- 获取并暴露 Workspace cwd、当前 Git branch、Pi version 等 Local environment info。
- 将 Pi 不存在、版本探测失败、无效 Workspace、spawn 失败、RPC process crash 映射为明确、稳定的错误信息/错误码。
- 通过 Tauri Command / Runtime 层暴露 Local Connection 探测与启动能力，React 不直接调用系统命令。
- 为 Local 探测、启动 spec 和关键错误映射添加 Rust 测试。

# 非目标

- 不实现 P0.4 WSL distro 枚举、WSL transport 或重连。
- 不实现 P0.5 SSH transport。
- 不实现 session 索引、SQLite、历史会话扫描或聊天协议扩展。
- 不新增与 P0.3 无关的 UI；仅在现有边界需要时提供可供 UI 消费的 typed payload。
- 不改变 PiSession 的 JSONL framing、generation stale-event 规则和 stdout/stderr 分流语义。

# 验收示例

- A1: Local Connection 有稳定的 typed model，可表示本机连接和探测到的环境信息。
- A2: Local 探测能找到 PATH 中的 `pi`；找不到时返回明确的 `pi_not_found` 类错误，而不是通用 spawn 错误。
- A3: 能获取 Pi 版本，并把原始版本输出整理为稳定字段返回。
- A4: 给定存在的 Workspace，Local launcher 以该目录为 cwd 启动 `pi --mode rpc`，且生产参数中不存在 `--no-extensions`。
- A5: environment info 至少包含规范化 cwd、Git branch（非 Git 仓库时允许为空）和 Pi version。
- A6: Workspace 不存在/不是目录、Pi 版本探测失败、Pi spawn 失败均具有明确可区分的错误码与消息。
- A7: Pi RPC 非零退出会继续通过 runtime error/process state 事件对上层可见，不把 stderr 混入 RPC stdout。
- A8: Local Connection 能复用 P0.2 的 PiSession / ProcessSpec，不把 Local 特有逻辑散落进 JSONL codec 或 React。
- A9: Rust 格式、check、clippy、test 通过；前端若有改动则 pnpm format/check/build 通过。

# 约束与不变量

- 架构保持 `React -> Tauri Commands/Events -> PiSession -> Pi RPC Codec -> PiTransport/ProcessSpec`；Local 负责构造本地探测和 process spec。
- Pi stdout 仍只用于 RPC JSONL，stderr 仍只作为运行日志。
- RPC framing 仍严格以 LF (`\n`) 为边界。
- Pi launcher 必须保留正常 user/global/project extensions 加载语义，禁止生产使用 `--no-extensions`。
- Tauri Command 只做参数转换和 runtime 调用，不堆积系统探测业务逻辑。
- 当前开发环境为 WSL；这里只做代码、Rust/前端构建和静态验证，Windows 桌面窗口验证不作为 WSL 自动检查的一部分。

# 决策

- 新增独立 Local connection/transport 模块，集中负责 executable/version/workspace/git 探测和 `ProcessSpec` 构造；PiSession 继续保持 transport-agnostic。
- 使用当前进程 PATH 解析 `pi`，实际启动使用探测到的 executable path，避免探测与启动使用不同二进制。
- Pi version 通过独立短命令探测；Git branch 通过 `git -C <workspace> branch --show-current` 或等价 plumbing 获取，失败/非仓库不阻断 Local Connection。
- Local start command 接受 Workspace path，先完成环境探测再交给 PiSession spawn，以便在真正 spawn 前给出更具体的错误。

# 待解决问题

- Pi 在不同安装方式下 `--version` 的精确输出格式需要实现时结合本机版本确认，解析逻辑应保留原始文本并避免依赖过窄格式。
- UI 如何展示 Local environment info 可留给后续 Workspace/Connection UI 阶段；P0.3 只保证 typed backend payload 已可消费。

# 验证预期

- `cargo fmt --all --check`
- `cargo check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test`
- 若修改前端：`pnpm format`、`pnpm check`、`pnpm build`
- 复核 Local launcher 的 argv 明确包含 `--mode rpc` 且不包含 `--no-extensions`。
- 复核 diff 仅包含 P0.3 Local Connection、必要的 Runtime/Tauri 接线、ROADMAP/Comet artifacts。
