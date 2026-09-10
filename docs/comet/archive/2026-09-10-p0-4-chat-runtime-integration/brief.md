# 目标

让 Pilo 的 Chat 页面通过现有 Local Connection 与真实 Pi RPC 完成基础端到端聊天，并在 Pi 原始事件与 UI 之间引入一层保持语义稳定的薄 Runtime Event 适配。

# 范围

- 复用 P0.3 已实现的 Local Connection 与 `pi --mode rpc` 生命周期，不重新实现进程管理。
- Chat 首次发送前确保本地 Pi RPC 已启动，并通过 RPC `prompt` 命令发送用户输入。
- 在后端将 Chat 当前需要消费的 Pi AgentSession 原始事件映射为 Pilo 自己的语义事件；不把完整 Pi 事件协议直接暴露给 React。
- 前端监听统一的 `pilo://runtime` 事件，按会话运行状态创建/更新 assistant 消息。
- 支持文本增量流式展示、一次回复结束后继续下一轮，以及生成中的停止操作。
- Pi 启动、RPC 写入、协议解析或运行时失败时，Chat 保留用户消息并展示可理解的错误状态，允许后续重试。
- 工具调用活动展示保持简洁：运行中的工具调用可展开查看输出，回复完成后自动收起为单行摘要，点击可再次展开；详情使用单一天然区块，不渲染「参数」「输出」独立标题面板。
- 保留原始 Pi RPC 消息用于后端日志/调试边界，不要求 UI 消费 raw payload。

# 非目标

- 本次不实现 WSL/SSH Connection；这些连接后续复用同一 Runtime Event 语义层。
- 不实现完整 Session 扫描、历史导入、SQLite 索引或跨启动恢复。
- 不实现完整 tool call / extension UI 的产品化展示；若 Pi 发出当前未映射事件则忽略或保留为调试信息。
- 不在前端复制 Pi 的完整 RPC type system，也不设计通用的跨 Agent 协议。
- 不要求在 WSL 中完成 Windows Tauri 桌面窗口的人工 UI 验证。

# 验收示例

- A1：在本地工作区打开 Chat，输入普通文本并发送后，Pilo 会通过 Local Connection 启动或复用真实 Pi RPC，并发送对应 `prompt`，而不是生成 mock 回复。
- A2：当 Pi 返回 assistant 文本增量时，Chat 中同一条 assistant 消息持续追加文本，生成期间显示为 running/streaming，结束后转为完成状态。
- A3：第一轮完成后再次发送第二条消息时复用同一 Pi 进程/会话并得到第二轮回复，不需要重新加载页面或重新启动 Pi。
- A4：生成期间点击输入框的停止按钮会向当前 Pi 会话发送 `abort`，当前回复停止继续增长，并恢复到可再次输入和发送的状态。
- A5：Pi 启动失败、RPC 发送失败或 runtime error 到达前端时，Chat 展示错误反馈且不会静默丢失已提交的用户消息。
- A6：React Chat 层只消费 Pilo Runtime Event 的稳定语义字段；Pi 原始 AgentSession/RPC 事件的字段解析集中在后端适配边界。
- A7：当前尚未映射的 Pi event 不会导致 Chat 崩溃或破坏后续已支持事件处理。
- A8：前端 `pnpm check`、`pnpm build` 与 Rust `cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings` 通过；Windows `pnpm tauri dev` 作为目标环境人工验证项保留。
- A9：一次回复完成后，助手消息中的工具调用列表自动收起：每个工具调用仅显示单行摘要（图标、工具名、关键参数预览），点击行可展开查看参数与输出；展开详情为单一轻量区块，不再渲染「参数」「输出」独立标题面板。

# 约束与不变量

- Pi JSONL/RPC 仍是对话事实来源，Pilo 不复制 Pi 的对话协议或长期消息事实源。
- Connection 只负责运行环境/传输边界；Pi 事件语义适配属于 Runtime，不放进 React，也不让 Local/WSL 各自复制一套映射。
- Runtime Event 只新增当前 Chat 功能实际需要的语义，避免提前抽象完整 universal agent protocol。
- 保持现有 `pilo://runtime` 单一 Tauri event channel，并保留 generation 隔离，旧 Pi 进程事件不得污染当前会话。
- 运行目标为 Windows Desktop；WSL 用于代码开发、静态检查和 Rust/前端构建验证。

# 决策

- 使用“Pi raw event → Pi Event Adapter → Pilo Runtime Event → Chat”结构；不让 Chat 直接依赖 Pi raw event。
- 适配层保持薄，只覆盖本阶段需要的 assistant 文本流、回复生命周期、停止和错误语义；tool/activity UI 后续按实际需求扩展。
- Local 与未来 WSL/SSH 连接共享同一 Pi Runtime/Event Adapter，Connection 不负责解释 Pi 事件。
- 停止生成使用 Pi RPC 的 `abort` 命令，而不是停止整个 Pi 进程；进程级 stop/restart 仍保留给 Runtime 生命周期管理。
- 当前变更在现有 `main` 工作目录直接实现，不创建额外 worktree。
- 工具调用活动采用“运行中可见、完成自动收起、点击切换”的折叠行为；不做逐工具定制视图（diff 渲染等），留待后续按实际需求扩展。

# 待解决问题

无。

# 验证预期

- 为 Pi raw event → Runtime Event 的映射补 Rust 单元测试，覆盖文本增量、结束、忽略未知事件及稳定序列化。
- 为 prompt/abort RPC 命令构造或 Chat runtime client 的纯逻辑补可自动运行测试（若当前前端测试基础设施不足，则至少通过 TypeScript build 与 Rust 单测覆盖协议边界）。
- 运行 `pnpm format` 后执行 `pnpm check`、`pnpm build`。
- 运行 `cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings`，并运行相关 `cargo test`。
- Windows 侧最终人工检查：真实发送、流式追加、连续第二轮、停止生成、错误展示、工具调用完成后收起为单行摘要且可点击展开。
