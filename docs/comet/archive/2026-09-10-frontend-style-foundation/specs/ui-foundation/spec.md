# UI Foundation

Pilo 前端的设计基础：主题 token、配色、字体、基础组件集与应用布局骨架。全部视觉风格移植自 Lody，后续所有界面开发以此为准。

## 主题 Token

- 使用 Tailwind CSS 4 原生 `@theme` / CSS 变量定义主题，不引入 Tailwind 3 JS config 桥接。
- 颜色 token 为 HSL CSS 变量，分 `:root`（亮色）与 `.dark`（暗色）两组；亮色取值解析自 Lody 内置主题 `lody-light.json`（经 LODY_ALIAS_RULES 计算的生效值，如侧栏 #F7F8FA、选中 #E8EAEF、主色 #5B8DEF），暗色沿用 Lody `packages/components/src/tailwind/index.css` 的 `.dark` 默认值，至少包括：background、foreground、card、popover、primary、secondary、muted、hover、selection、destructive、border、input、ring、sidebar 系列、status 系列及各自 foreground。
- 另含圆角（radius）、控件高度、阴影、动效时长等尺寸 token，供组件统一引用。
- 组件与布局只能引用 token，不得出现硬编码色值。

Scenario: 查看任意界面元素的颜色定义，其颜色均来自 CSS 变量 token，源码中不存在硬编码十六进制或 rgb 色值。

## 主题模式

- 提供亮色、暗色、跟随系统三种模式，用户可在界面中切换，切换立即生效。
- 跟随系统时监听操作系统偏好变化。
- 暗色使用 Lody dark token。

Scenario: 在运行界面中切换亮色/暗色/跟随系统模式，页面背景、侧边栏、文字与组件颜色随之立即切换。

## 字体

- 通过 @fontsource 自托管 Inter（正文）与 JetBrains Mono（等宽），不依赖系统安装字体。
- 正文默认 Inter，中文回退到系统无衬线字体栈；代码等宽场景使用 JetBrains Mono。

Scenario: 在无 Inter/JetBrains Mono 系统字体的环境中运行，界面正文仍渲染为 Inter、等宽文本仍渲染为 JetBrains Mono。

## 基础组件集

- 以 shadcn/ui 模式将 Lody 组件源码拷贝进本仓库（`src/ui/`），可自由修改，不以 npm 包依赖 Lody。
- 组件集：button、input、textarea、label、card、badge、avatar、dialog、dropdown-menu、popover、tooltip、select、tabs、switch、checkbox、scroll-area、separator、skeleton、sonner，统一从 `src/ui` 入口导出。
- 组件基于 Radix UI + class-variance-authority，样式全部引用主题 token。
- 不移植 Lody 中带业务或重依赖的组件（window-drag-region、drawer、command、emoji-picker、focus-scope 等）。

## 图标

- 图标统一使用 lucide-react（与 Lody 移植组件一致，图标风格为 Linear 式细线条）。
- 图标颜色跟随 currentColor，通过 size 与 className 控制尺寸和着色。

Scenario: 界面任意位置的图标（含组件内部 chevron、close、check 等）均渲染自 lucide-react，与 Lody 原版组件一致。

Scenario: 从统一入口导入上述任一组件并在界面中渲染，其外观符合主题（圆角、颜色、悬停态），其中按钮、输入框、卡片、弹窗在应用界面中有真实使用。

## 应用布局骨架

- 呈现 Lody 主界面静态骨架（占位内容，不接逻辑）：左侧边栏（顶部新建入口、工作区分组、会话列表、底部工具栏）、主内容区（居中标题）、底部输入框区域。
- 布局使用主题 token 表达颜色层级：白色页面、冷灰侧边栏、细边框分隔。

Scenario: 启动应用可见左侧边栏（含分组与会话列表占位项）、居中主标题和底部输入框区域，整体配色与参考截图一致。

## 工程约束

- 遵循 AGENTS.md：UI 与 Runtime 分离，React 不直接调用系统能力。
- 默认保留 Tauri 原生窗口装饰；Windows 桌面端例外，启用自绘标题栏与窗口控制按钮（见 brief 决策修订）。
- 验证命令：`pnpm format`、`pnpm check`、`pnpm build` 全部通过。
