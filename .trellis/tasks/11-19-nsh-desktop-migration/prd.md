# 桌面端迁移到 nsh

## Goal

把 Pilo 桌面端的界面从 Tauri + React 换成 [nsh](https://github.com/longbridge/nsh)（Native Shell：Rust 实现的原生 UI 框架，界面用 TSX 编写），由原生控件渲染而不是 WebView。WebUI（`src/remote/`）继续使用 React，`pilo-server` 与 `pilo-protocol` 两端共用。迁移完成前现有 Tauri 版本照常发版。

本任务是父任务：持有需求、任务图、跨子任务验收和最终集成评审，不直接承载实现。

## 背景与已确认事实

### Pilo 现状

- 前端 `src/` 约 6.8 万行 TS/TSX/CSS、193 个 React 文件。按目录：`components/chat` 19,306 行、`lib` 15,324 行、`remote` 10,339 行、`components/settings` 6,091 行、`components/app` 3,958 行、`components/sidebar` 2,695 行、`ui` 2,154 行、`i18n` 2,142 行、`styles` 1,150 行。
- 不依赖 React / Tauri / DOM 的纯逻辑：`src/lib` 58 个文件 7,699 行，其中 `src/lib/chat` 29 个文件 4,388 行（`conversation-reducer.ts`、`chat-streaming-markdown.ts`、`chat-mentions.ts`、`chat-tool-result.ts` 等）。
- 桌面端与 WebUI 已通过 `PiloClient` 接口隔离（`src/lib/api/pilo-client.ts:72`，约 40 个方法），实现分别是 `tauri-pilo-client.ts` 和 `src/remote/web-pilo-client.ts`。桌面端另有直接 `invoke` 的 API 文件：`projects.ts`、`connections.ts`、`ssh-connections.ts`、`sessions.ts`、`pi-runtime.ts`、`pi-models.ts`、`terminal.ts`、`files.ts`、`parallel.ts`、`preview.ts`、`window.ts`。
- `src-tauri` 约 3.07 万行 Rust、125 个文件，其中 46 个文件引用 `tauri::`。127 个 `#[tauri::command]` 集中在 `src-tauri/src/runtime/commands/`（2,369 行）。`runtime/` 下另有 26 个非 command 文件持有 `AppHandle`（路径、事件发送、状态获取）。
- Tauri 插件：`autostart`、`global-shortcut`、`single-instance`、`opener`、`window-state`、`notification`、`updater`、`process`、`log`，以及调试用 `wdio-webdriver`。
- WebUI 静态资源由 Tauri 的 `asset_resolver()` 提供（`src-tauri/src/runtime/remote/api/mod.rs:256`）；`pilo-server` 运行时作为 Tauri resource 打包（`runtime/server_deploy/target.rs`）。
- 应用数据目录来自 Tauri `app_data_dir()`，标识符 `app.hsingjui.pilo`（开发版 `app.hsingjui.pilo.dev`），见 `src-tauri/src/runtime/host_paths.rs`。
- 发版：Windows NSIS 安装包、macOS aarch64、Linux `deb` / `rpm` / `AppImage`（`.github/workflows/release.yml`）；自动更新用 `tauri-plugin-updater`，minisign 公钥，清单在 GitHub Releases `latest.json`。
- 主题：亮/暗/跟随系统 × 主题族 `lody` / `claude` / `custom`；自定义主题是任意 CSS 文本，可保存多套（`src/lib/theme-settings.ts`、`src/lib/theme-custom.ts`）。

### nsh（v0.6.0，2026-11-19 调研）

- 桌面后端：macOS AppKit、Windows Win32 + Direct2D、Linux GTK 4；同一份代码可出 Web 包。
- TSX 是 signal 响应式写法，不是 React：没有 hooks、没有 DOM、没有 CSS 文件；支持 Tailwind 4 类名和主题 token。
- 自带组件：虚拟列表 `List`、流式 Markdown `TextView`、`DiffView`、`Terminal`、`Editor`、`RichEditor`（含 mention）、`Collapsible`、`Popover`、`Dialog`、`Menu`、`Command`、`Tree`、`Resizable`、`Tabs`、`Toast`、`Tooltip`。
- 桌面能力（`nsh/desktop`）：多窗口、自定义标题栏、窗口状态、菜单、托盘、全局快捷键、单实例、开机启动；另有 `nsh/updater`、`nsh/i18n`。
- Rust 接入：应用 crate 用 `#[native_module]` 导出 `#[module]` / `#[class]` / `#[component]`，TSX 从 `app/native` 导入；`async fn` 对应 Promise，`on(event, listener)` 返回停止函数，`background(…)` 可跑 Tokio；TypeScript 声明由 Rust 类型生成。
- 打包：Windows 输出目录 + zip + Inno Setup 安装器；macOS 输出 `.app`（要求 macOS 14+）；Linux 输出目录 + `tar.gz`（要求 GTK 4.14+，约 Ubuntu 24.04 起）。
- 成熟度：首个 commit 2026-10-14，每周发版，兼容性承诺只覆盖已记录的 release。

### 已做的原型验证（`research/nsh-feasibility.md`）

- 526 行 TSX 的 Chat 页面原型，在 macOS 原生窗口和浏览器两端通过同一套交互测试：三级工具折叠、多行 Composer 发送/停止、流式 Markdown、模型弹层、会话切换、2000 条消息虚拟列表、暗色、390px 窄屏。
- 运行时切换主题族（Lody / Claude）和亮暗，颜色与圆角 token 即时生效。
- 未验证：Windows 上的任何行为、真实输入法输入、`@` 提及、附件与粘贴图片、Rust 运行时接入、真实 Pi RPC 数据。

## Requirements

1. 桌面端界面全部由 nsh 渲染，发版产物不再包含 Tauri 和 WebView 前端；WebUI 仍由 React 构建并由桌面 Host 内嵌提供。
2. 现有 Rust 业务逻辑（Connection、Project、Session 索引与历史、Pi RPC、事件总线、Remote Host、存储）保留并复用，不重写；Tauri 专属胶水（command、插件、窗口）替换为 nsh 对应能力。
3. `pilo-server`、`pilo-protocol`、Remote HTTP/WS 接口和 Pi 会话文件格式不变；WebUI 行为不变，唯一例外是自定义主题格式（第 7 条）。
4. 桌面端功能与切换时的 Tauri 版本对齐，范围以“功能对齐清单”为准（在 M1 产出，逐项标注必须 / 可延后）。
5. Local / WSL / SSH 三种 Connection 都可用。
6. 用户数据不丢：沿用现有数据目录、SQLite、偏好设置和主题设置，升级后无需重新配置。
7. 主题系统保留亮/暗/跟随系统、Lody / Claude 主题族和可保存的多套自定义主题。自定义主题的内容由任意 CSS 改为 token 表，桌面端与 WebUI 使用同一格式；已保存的旧主题自动转换，无法转换的规则（带选择器的样式）向用户列出。
8. 迁移期间 `main` 上的 Tauri 版本可继续开发和发版，且不因迁移而改动；迁移分支定期合入 `main`，并保持分支上的 Tauri 版本可编译、可运行，直到 M7。
9. 每个里程碑结束时桌面应用可运行、可演示，并有对应的自动化测试（`nsh test`）。
10. 发布目标平台都要有原生验证：Windows 为首要目标，macOS、Linux 次之。

## Acceptance Criteria

- [ ] M0 四项风险验证全部有结论，并据此确认继续或中止（见子任务 `11-19-nsh-m0-risk-spikes`）。
- [ ] 功能对齐清单中的“必须”项全部在 nsh 桌面端通过验证，Local / WSL / SSH 各走通一次完整对话（发送、流式、工具调用、中止、切换会话、重启后恢复）。
- [ ] 使用 Tauri 版本的现有数据目录启动 nsh 版本：项目、会话、偏好、主题、已配对的 Remote 设备全部保留。
- [ ] 对话大纲在 nsh 桌面端可用：列出当前会话的用户消息，点击跳转到对应位置，滚动时高亮当前所在条目。
- [ ] 延后项有替代表现：Mermaid 代码块显示源码；项目可通过菜单上移 / 下移排序。
- [ ] 自定义主题：新建、编辑、保存、切换、删除在桌面端和 WebUI 表现一致；无效 token 被拒绝并提示，当前主题不受影响；一份含变量和选择器规则的旧 CSS 主题升级后，变量部分生效，选择器规则出现在提示列表中。
- [ ] WebUI 在 nsh Host 下通过现有验证（浏览器配对、对话、移动端窄屏），`src/remote/` 无功能回退。
- [ ] Windows：安装包安装、覆盖升级、卸载；中文输入法输入；托盘、全局快捷键、单实例、开机启动、系统通知、自动更新各验证一次。
- [ ] macOS（14 及以上）：安装包启动并完成一次完整对话。
- [ ] Linux：`deb`、`rpm`、`AppImage` 三种包各在一个满足 GTK 4.14+ 的发行版上安装、启动并完成一次完整对话；桌面入口和图标正确。
- [ ] 长会话（2000 条以上真实历史）滚动、流式输出时的帧率和内存不差于同机 Tauri 版本，数据记录在任务 `research/`。
- [ ] `cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings`、`nsh check`、`nsh test` 通过；WebUI 侧 `pnpm check`、`pnpm build` 通过。
- [ ] `.trellis/spec/` 新增 nsh 桌面端的目录结构、组件、状态和桥接规范；`AGENTS.md` 的技术栈、架构图、UI 规则和 Validation 更新为迁移后的状态。

## Out of Scope

- WebUI 迁移到 nsh（保留 React，后续单独决定）。
- iOS / Android 原生客户端。
- 改动 `pilo-server`、`pilo-protocol` 或 Pi RPC 行为。
- 借迁移之机新增产品功能或重新设计界面。
- 对话内查找、Mermaid 渲染、侧边栏项目拖拽排序（延后到切换发版之后，单独立任务）。
- 向 nsh 上游贡献代码（缺失能力先在应用内实现；确需上游改动时单独提出）。

## Decisions

- 桌面端先迁移，WebUI 保留 React（2026-11-19，用户确认）。
- 在长期分支 `nsh-migration` 上进行，新界面代码放在仓库内的独立目录，与 `src/` 并列（2026-11-19，用户确认方向）。
- 使用 Trellis 工作流，父任务 + 按里程碑的子任务（2026-11-19，用户确认）。
- Rust 运行时去 Tauri 依赖只在 `nsh-migration` 分支上做，`main` 保持不动（2026-11-19，用户确认）。由此产生的约束：迁移分支负责解决每次合入 `main` 时的冲突；抽离阶段不移动文件，降低冲突面（见 `design.md` 第 3 节）。
- 平台范围（2026-11-19，用户确认）：macOS 最低版本升到 14；Linux 继续发 `deb` / `rpm` / `AppImage`，由仓库内的打包脚本基于 `nsh package` 的产物生成；Windows 改用 Inno Setup 安装器。Linux 运行环境需要 GTK 4.14+（约 Ubuntu 24.04 起），更旧的发行版在切换后无法升级。
- 自定义主题改为 token 表，旧主题自动转换，WebUI 也统一成只认 token（2026-11-19，用户确认）。这是对 WebUI 的可见行为变化：带选择器的自定义 CSS 在两端都不再生效。改动随迁移分支进行，在切换发版时一起发布，`main` 不提前改。
- 切换发版的功能范围（2026-11-19，用户确认）：对话大纲（outline rail）切换前必须对齐；对话内查找、Mermaid 渲染、侧边栏项目拖拽排序延后到切换之后。延后期间 Mermaid 以代码块显示源码，项目排序用菜单“上移 / 下移”替代，查找入口不提供。
- 从 Tauri 版升级到 nsh 版的过渡方式推迟到 M7 开始前决定（2026-11-19，用户确认）。候选：最后一个 Tauri 版提示手动安装；验证后由 Tauri 更新器运行 nsh 安装包；两套版本并行发布。不阻塞 M0–M6。

## Open Questions

按影响排序，逐个确认；全部确认前不进入实现。

1. **界面语言**：TSX + Rust 模块（推荐，可热更新、可复用现有 TS 纯逻辑），还是纯 Rust。
2. **止损标准**：M0 哪些项不通过即中止迁移。
