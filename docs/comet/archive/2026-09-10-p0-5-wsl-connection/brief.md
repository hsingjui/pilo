# 目标

为 Pilo 增加可复用的 WSL Connection，使 Windows Tauri 能通过 `wsl.exe` 选择目标发行版，在该发行版的 Linux cwd 中探测开发环境并启动真实 `pi --mode rpc`。WSL 只负责运行环境与进程启动边界，已有 Pi Session、JSONL RPC、Runtime Event Adapter 与 Chat 语义保持共享。

# 范围

- 通过 Windows `wsl.exe` 枚举已安装 WSL distributions，返回稳定、可序列化的数据结构。
- 增加 `WslConnection`、`WslDistribution`、`WslEnvironmentInfo` 等领域模型，并映射到现有通用 `ConnectionKind::Wsl`。
- 接受目标 distro 与 Linux workspace path，验证 cwd 可访问，并在该环境内探测 Pi、Node、Git 及 Git branch 等基础环境信息。
- 构造 WSL Pi launch plan：Windows 侧启动 `wsl.exe`，目标 distro 内以探测到的 Pi 绝对路径运行 `pi --mode rpc`，stdout/stdin/stderr 继续由现有 `ManagedProcess` / `PiSession` 桥接。
- 暴露 WSL list/probe/start Tauri commands，并保留现有通用 `runtime_restart_pi` 作为 WSL 重连路径；重连必须复用上一次 WSL connection 与 launch plan。
- 为前端 runtime client 增加 WSL 调用与类型，使后续 Connection/Workspace UI 可直接消费；本阶段不扩展产品 UI。
- 使用当前主要 WSL Debian 开发环境做真实 distro/环境探测验证；Windows 桌面端完整 UI 仍属于目标环境人工验证。

# 非目标

- 不实现 SSH Connection、Workspace 管理/切换 UI、Session 扫描/导入或 SQLite 索引。
- 不为 WSL 复制 Pi raw event 解析、Chat Runtime Event 或另一套 RPC codec。
- 不同步或镜像 WSL 项目到 Windows 文件系统。
- 不在本阶段处理跨 distro session 迁移或自动选择工作区。

# 验收示例

- A1：调用 WSL distro 枚举时，Pilo 能通过 `wsl.exe` 返回已安装 distribution 名称；对 `wsl.exe --list --quiet` 的 Windows 输出编码/空字符做稳健解析，当前环境至少能识别 `Debian`。
- A2：`WslConnection` 能稳定序列化为现有通用 `Connection`，其 kind 为 `{ type: "wsl", distro: "..." }`，且不会改变 Local Connection 的序列化契约。
- A3：给定 distro 与 Linux cwd，WSL probe 能确认目录可访问，并返回 Pi executable/version、Node executable/version、Git executable/version 与可用的 Git branch；探测失败时返回稳定错误码和可理解信息。
- A4：启动 WSL Pi 时，Windows 侧 launch program 为 `wsl.exe`，参数明确指定目标 distro 与 Linux cwd，并在 WSL 内以探测到的 Pi executable 启动 `--mode rpc`；不得让登录 shell/banner 污染 RPC stdout。
- A5：WSL Pi 的 stdin/stdout/stderr 使用现有 `ManagedProcess` 与 `PiSession` 管线，因此 `prompt`、流式 assistant/tool/thinking events、`abort` 和错误事件沿用同一 `pilo://runtime` 契约。
- A6：WSL Pi 已启动后 `runtime_get_pi_state` 返回对应 WSL Connection；调用通用 `runtime_restart_pi` 会停止并按上次 distro/cwd/Pi launch plan 重启，不退回 Local Connection。
- A7：现有 Local Connection 与 Local Chat 行为不回归；相关 Rust 单测继续通过，新增 WSL parsing/model/launch-plan 测试覆盖主要边界。
- A8：`pnpm check`、`pnpm build`、前端单测，以及 Rust `cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo test` 通过；当前 Debian 环境执行真实 WSL/工具探测并记录结果。

# 约束与不变量

- Pi JSONL/RPC 仍是会话事实来源；Connection 只负责环境探测与进程启动。
- WSL Linux path 以字符串保持 Linux 语义，避免由 Windows `PathBuf` 进行平台化改写。
- RPC stdout 必须只来自 Pi 进程；环境探测可以使用 shell，但 Pi RPC 启动不经过交互式/登录 shell。
- 现有 `ProcessSpec` / `PiSession` 是 Local/WSL/未来 SSH 的共享进程与 RPC 生命周期边界。
- 运行目标仍为 Windows Desktop，WSL 作为代码开发和 Linux 项目执行环境。

# 决策

- WSL transport 不新增第二套 process manager；把 `wsl.exe` 包装成现有 `ProcessSpec` 的 program/args 即可复用 stdio 管线。
- distro 枚举优先使用 `wsl.exe --list --quiet`，解析层显式兼容 UTF-8 与常见 UTF-16LE/NUL 输出。
- 环境 probe 在 WSL 内运行短生命周期命令并使用机器可解析输出；Pi RPC launch 使用 probe 得到的 Pi 绝对路径，避免依赖登录 shell PATH。
- WSL restart 直接复用 `PiSession::restart` 已保存的 `Connection + ProcessSpec`，不增加重复的 reconnect 状态机。
- 当前 change 在 `main` 工作目录直接实现，不创建额外 worktree。

# 待解决问题

无。

# 验证预期

- Rust 单测覆盖 distro 输出解析、WSL model 序列化、Linux path/参数构造、错误码和 launch plan。
- 运行全部前端与 Rust repository checks。
- 在当前 Debian WSL 环境通过 Windows `wsl.exe`（可用时）真实执行 distro list/probe，并确认 Pi/Node/Git；若宿主互操作不可用，则明确记录为目标环境人工验证项。
- Windows 侧最终人工验证：选择 Debian、指定 Linux cwd、启动 Pi RPC、发送/停止/第二轮、停止后 restart。
