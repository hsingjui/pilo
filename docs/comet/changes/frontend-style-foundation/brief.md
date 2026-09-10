# 目标

初始化 Pilo 前端的整体设计体系：从 Lody（/root/code/github/Lody）移植设计风格、配色 token 和 shadcn/ui 风格基础组件，使 Pilo 界面呈现截图所示的 Lody 风格（Linear 式冷白亮色、蓝色主色、干净留白），作为后续所有界面开发的统一基础。

# 范围

## Source coverage

| 来源 | 定位 | 读取状态 | 保留语义 | 覆盖状态 | 理由 |
| --- | --- | --- | --- | --- | --- |
| 用户请求文字 | 本会话首条消息 | complete | 初始化前端整体风格与组件；风格配色和组件取自 Lody；参考截图 | covered | 直接需求，映射为下方验收项 |
| 截图 1（主界面） | /tmp/orca-paste-1789003995550-0affb624-51fe-4913-9056-aba1de7f0b4d.png | complete | 亮色主题；左侧会话边栏（工作区分组、会话列表、底部工具栏）；主区居中欢迎语；底部输入框与上下文徽章 | covered | 视觉目标参考，映射为布局骨架验收 |
| 截图 2（设置-账号） | /tmp/orca-paste-1789004006188-c1605f12-fcce-4726-b8b3-a16dda8c61e8.png | complete | 设置弹窗：左侧导航 + 右侧内容；卡片式分组；描边按钮 + 蓝色主按钮 | covered | 视觉目标参考，映射为组件风格验收 |
| 截图 3（设置-关于） | /tmp/orca-paste-1789004026520-5db92184-584c-4d31-aed3-6f9c7c31c9f4.png | complete | 设置弹窗另一页；列表行布局；蓝色链接按钮 | covered | 视觉目标参考，映射为组件风格验收 |
| Lody 仓库 | /root/code/github/Lody | partial | 作为风格 token、配色和组件的移植来源；已读取 packages/components 的 tailwind preset、index.css 主题变量（light/dark）、ui/ 组件清单和依赖、@lody/configs/tailwind-preset | covered | 移植来源，按需读取；不引入 Lody 业务逻辑、移动端（konsta）、VS Code 主题集成 |
| Reicon 图标库 | https://github.com/dqev/reicon | complete | 用户最初指定的图标库；后续用户在 Build 阶段改为 lucide-react（与 Lody 一致），本单元已废弃 | superseded | 被 lucide-react 决策取代，指向 Q5 修订与 A8 新文字 |

已调查事实：

- Pilo 前端现状：React 19 + Vite + Tailwind CSS 4（@tailwindcss/vite）+ clsx + tailwind-merge；无组件库、无设计 token；App.tsx/App.css 为脚手架残留。验证命令：`pnpm format`、`pnpm check`、`pnpm build`（Rust 侧 cargo fmt/check/clippy）。
- Lody 设计体系：shadcn/ui（new-york 风格）组件集位于 packages/components/src/ui/（约 40 个组件），基于 Radix UI + class-variance-authority + lucide-react；主题 token 为 HSL CSS 变量（:root light + .dark），含完整 sidebar/tab/status/code/syntax 语义色；字体 Inter + JetBrains Mono（@fontsource 自托管）。
- Lody ui 组件中大部分仅依赖 Radix/cva/lucide；少数带 Lody 特有依赖（window-drag-region→electron、sonner→theme-provider、drawer→vaul、command→cmdk、emoji-picker→frimousse、focus-scope→jotai），本次不移植这些。

# 非目标

- 不实现任何业务功能（连接管理、会话、Pi RPC 等）；布局骨架使用占位内容，不接真实数据。
- 不移植 Lody 的移动端（konsta）、VS Code 主题系统、i18n、Electron 专属代码，以及带额外重依赖的组件（drawer/command/emoji-picker/focus-scope 等）。
- 不做自绘标题栏/窗口控制按钮（保留 Tauri 原生窗口装饰）。（2026-09-10 修订：Windows 桌面端例外，启用自绘标题栏，见决策）
- 不引入 Storybook 等组件文档工具。

# 验收示例

- A1: `pnpm build` 与 `pnpm check` 全部通过。
- A2: 应用呈现 Lody 亮色风格：白色页面背景、冷灰侧边栏、蓝色主色按钮与高亮、细边框卡片，与参考截图视觉一致。
- A3: 核心基础组件集可从统一入口导入，包含 button、input、textarea、label、card、badge、avatar、dialog、dropdown-menu、popover、tooltip、select、tabs、switch、checkbox、scroll-area、separator、skeleton、sonner；其中按钮、输入框、卡片、弹窗在界面中有真实使用。
- A4: 颜色全部来自主题 token（CSS 变量），组件与布局中不出现硬编码色值。
- A5: 提供亮色/暗色/跟随系统三种主题模式并可切换，暗色使用 Lody dark token；切换在运行界面中立即可见。
- A6: 应用呈现截图 1 的静态布局骨架：左侧边栏（顶部新建入口、工作区分组、会话列表、底部工具栏）、主内容区（居中标题）、底部输入框区域；全部为占位内容。
- A7: 界面默认字体为自托管 Inter，等宽场景为 JetBrains Mono，不依赖系统安装的同名字体。
- A8: 图标统一使用 lucide-react（与 Lody 移植组件一致），图标颜色跟随 currentColor，可通过 className/size 着色与控制尺寸。

# 约束与不变量

- Tailwind CSS 4 原生方式（@theme/CSS 变量），不引入 Tailwind 3 JS config 桥接。
- 组件为 shadcn/ui 模式：源码拷贝进 Pilo 仓库（src/ui 或 src/components/ui），可自由修改，不以 npm 包形式依赖 Lody。
- 遵循 AGENTS.md：UI 与 Runtime 分离，不在 React 中直接调用系统能力。
- 本主题为纯前端改动，与 Local/WSL/SSH 连接环境无关。

# 决策

- 主色与配色直接沿用 Lody 主题 token（用户明确"风格和配色直接拿 Lody 的"）。
- 保留 Tauri 原生窗口装饰，不做自绘标题栏。（2026-09-10 修订：Windows 桌面端启用自绘标题栏与窗口控制按钮，由用户在 Build 阶段自行实现；macOS/浏览器环境仍保留原生装饰）
- Q1 → A：只移植核心基础组件集，避免 Lody 业务/重依赖；后续按需再补。
- Q2 → A：亮色 + 暗色 token 全套建立，提供 亮色/暗色/跟随系统 切换。
- Q3 → A：本次搭建静态布局骨架（左侧边栏 + 主内容区 + 底部输入框），占位数据、不接逻辑。
- Q4 → A：@fontsource 自托管 Inter + JetBrains Mono。
- Q5 → A（2026-09-10 修订）：图标改用 lucide-react，与 Lody 移植组件保持一致；弃用此前“统一使用 reicon-react”的决策（用户主动将代码切回 lucide）。

# 待解决问题

无。

# 验证预期

- `pnpm format`、`pnpm check`、`pnpm build` 通过。
- 视觉核对：界面风格与参考截图一致（亮色、蓝主色、冷灰边栏）；主题切换可见生效。
