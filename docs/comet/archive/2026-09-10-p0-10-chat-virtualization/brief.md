# 目标

在不触碰 P0.5 WSL Connection 的 Connection / Runtime / Tauri 改动面的前提下，为 Pilo Chat 增加长 Session 消息列表 virtualization。长会话只挂载视口附近的消息，降低大量 Markdown、Thinking、Tool Result 节点同时存在时的 React/DOM 成本，同时保持当前 streaming、自动滚动、消息导航 rail 与 composer 遮挡体验。

# 范围

- 仅修改前端 Chat 消息渲染相关代码、前端依赖和针对 virtualization 的纯函数测试。
- 为长消息列表引入成熟的 variable-size virtualizer；短会话继续沿用直接渲染，避免给日常会话增加额外复杂度。
- 使用消息 id 作为稳定 item key，并动态测量 user / assistant 行高，兼容 Markdown、Thinking、Tool Result 和 streaming 内容增长。
- virtualization 开启后，消息导航 rail 跳转必须能定位到尚未挂载的历史消息，不再依赖目标 DOM ref 已存在。
- virtualization 开启后，scroll sticky 状态、滚动到底部按钮、streaming 自动跟随与发送消息后的回复 runway 继续工作。
- 保留当前消息列宽度、顶部/底部留白和 composer 自然遮挡行为。

# 非目标

- 不实现 WSL / SSH / Workspace / Session Index / SQLite。
- 不修改 Pi Runtime Event、RPC、Tauri command 或 Rust 代码。
- 不在本 change 实现 follow_up、steer、Model selector、Thinking level selector。
- 不实现 Session sidebar virtualization；这里只处理 Chat conversation message list。
- 不改变现有 Markdown、Thinking、Tool Result 的视觉样式或折叠语义。

# 验收示例

- A1：消息数量低于 virtualization 阈值时保持当前直接渲染路径；达到长会话阈值后只挂载视口附近消息，并保留合理 overscan。
- A2：virtualized item 使用消息 id 作为稳定 key，并能根据实际 DOM 高度重新测量；包含长 Markdown、展开/折叠活动块以及 streaming 增长时不会依赖固定行高。
- A3：长会话初次进入与切换 Session 后仍能定位到最新消息；sticky 状态下 assistant streaming 持续跟随底部，用户主动上滚后停止强制跟随，滚动到底部按钮可恢复跟随。
- A4：Conversation Outline 在长会话中点击任意 round 都能跳到对应消息，即使目标消息此前未挂载；当前 round 高亮不依赖所有消息 DOM ref 常驻。
- A5：发送新消息时现有 reply runway 逻辑仍生效；composer 与消息列布局、底部自然遮挡和滚动条对齐无回归。
- A6：改动不包含 `src-tauri/**`、Connection、WSL 或 runtime transport 文件，能够与 P0.5 独立合并。
- A7：`pnpm check`、`pnpm build`、`pnpm test:unit` 通过；新增纯函数测试覆盖 virtualization 阈值及 outline/message index 映射边界。

# 约束与不变量

- Pi streaming 数据模型和消息顺序保持不变，virtualization 只是渲染策略。
- 不因为 virtualization 丢弃消息对象或对 conversation truth 做分页裁剪。
- variable-height message 必须由真实元素测量，不以固定高度作为最终布局事实。
- 用户离开底部后不得因历史 item 测量变化被强制拉回底部。
- 长会话性能优化不得要求后端或 Session Index 已完成。
- 并行开发必须留在独立 worktree / branch，不修改正在进行 P0.5 的 main dirty files。

# 决策

- 使用 `@tanstack/react-virtual` 处理 variable-size virtualization，不自研滚动窗口算法。
- 仅在消息数达到 40 条时启用 virtualization；短会话保留现有 DOM 路径。
- virtualizer overscan 取 6 条消息，兼顾快速滚动与 Markdown 首次渲染成本。
- Outline entry 先映射到其起始 message index；virtualized 模式通过 index 滚动，非 virtualized 模式保留现有 DOM ref 跳转作为简单路径。
- active outline 在 virtualized 模式依据 reading line 对应的虚拟消息 index 推导，而不是扫描全部 DOM refs。

# 待解决问题

无。

# 验证预期

- 添加纯函数单测验证 39/40 条阈值以及 outline 起始 message index / active round 选择。
- 运行 `pnpm format`、`pnpm check`、`pnpm test:unit`、`pnpm build`。
- 审查最终 diff，确认没有 `src-tauri/**` 或 P0.5 change 文件交叉。
- 由于当前开发环境是 WSL，最终桌面滚动手感可在 Windows `pnpm tauri dev` 后补充人工确认；自动检查不依赖 Windows UI。
