# nsh 可行性调研与原型记录（2026-11-19）

## 调研对象

- 仓库：<https://github.com/longbridge/nsh>，CLI `nsh 0.6.0`。
- 环境：macOS（arm64）VM。未在 Windows、Linux 上运行。

## 原型 1：基础能力（80 行 TSX）

- 2000 条消息虚拟列表 + 流式 Markdown + `DiffView` + `Terminal`，同一份代码在 macOS 原生窗口和浏览器渲染正常。
- macOS 开发模式内存约 40 MB，空闲 CPU 1–3%。Web 包 10 MB，主 wasm 7.6 MB（brotli 后 1.8 MB）。
- 以上是原型观测值，不能外推为完整应用的性能。

## 原型 2：Chat 页面（526 行 TSX）

对照真实 Pilo（`pnpm dev` 下发送一条真实任务后读取 DOM 尺寸和样式）复刻：侧边栏、session header、消息列、三级工具折叠、Composer。

`nsh test --target macos` 与 `nsh test --target web` 均通过，覆盖：

| 交互 | 用到的 nsh 能力 | 应用层自己写的部分 |
|---|---|---|
| Work activity → 分组 → Write / Edit / Run 折叠 | `Collapsible`（`reveal` 动画） | 三级状态、摘要文案 |
| Edit 的 diff | `DiffView`（unified、行内高亮、语法高亮） | 需显式给高度，原型写死 |
| 流式回复 | `TextView` `options.streaming` | 模拟数据的定时器 |
| 2000 条消息会话 | `List`（`initialScrollAtEnd`、`maintainVisibleContentPosition`） | 回到底部按钮 |
| Composer | `Input`（`multiline`、`submitBehavior`、`onContentSizeChange`） | 自动增高、发送/停止状态 |
| 模型选择 | `Popover` | 列表项 |
| 图标 | `Canvas` + `Path2D` | 从 `lucide-react` 提取路径数据 |
| 主题 | `theme.json` token、`setColorScheme`、`setTheme` | Lody / Claude token 转换 |
| 窄屏 | Tailwind 断点 `max-md:` | — |

踩到的问题：

- `Text` 没有 `numberOfLines` / `selectable` 属性，要用 `truncate`、`select-text` 类。
- `Input` 从 `nsh/base` 导入，`onChange` 的参数是 `{ value }`。
- `DiffView` 不会按内容自适应高度。
- `nsh test` 默认无界面，截图必须加 `--target`；视口用 `app.setViewport` 设置。
- 字体通过 `import "./x.woff2"` 注册，中文回退到系统字体（PingFang SC）。

## 主题系统验证

- `setTheme({ cssVars })` 运行时替换整套 token，下一帧生效；`setTheme(null)` 还原。
- 颜色 token 与自定义数值 token（`rounded-(--bubble-radius)`）均生效。
- 文档说明：无效值会使 `setTheme` 整体抛 `TypeError` 并保留原主题；阴影这类值在运行时主题中被忽略（未实测）。

## 文档确认但未实测的能力

- Rust 模块导出（`#[native_module]`、`#[module]`、`#[class]`、`Callback`、`on` → `Stop`、`background` 跑 Tokio）。
- `nsh/desktop`：窗口、标题栏、窗口状态、菜单、托盘、全局快捷键、单实例、开机启动。
- `nsh/updater`：GitHub Releases 或自有地址，清单用 `nsh keygen` 的密钥签名。
- `RichEditor` 的 mention 扩展；`View` 的 `onFileDrop`；`Input` 的图片/文件粘贴事件。
- Windows 打包：目录 + zip + Inno Setup 每用户安装器，可就地升级；可执行文件不签名。

## 文档里没找到的能力

- Mermaid 渲染。
- 对话内查找（跨消息高亮与跳转）。
- 列表拖拽排序的高层 API（只有文件拖入和底层手势）。
- Service Worker / 离线 PWA（与桌面端无关，WebUI 保留 React 后不受影响）。

## 成熟度风险

- 首个 commit 2026-10-14；v0.6.0；近 30 天约 1,738 个 commit，80 个未关 issue（2026-11-19 观测）。
- 兼容性承诺只覆盖“已记录为兼容的 release”，`main` 上的 API 可能变化。

## 原型源码

原型不在仓库内（位于调研机器的 `/tmp/pilo-nsh-spike`，已打包为 `pilo-nsh-chat-spike.zip` 随会话附件提供）。M0 开始时作为 `nsh/` 目录的起点导入。
