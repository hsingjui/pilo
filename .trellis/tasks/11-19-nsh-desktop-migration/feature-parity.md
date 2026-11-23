# nsh 桌面端功能对齐清单（M1）

**状态：jui 于 2026-11-19 确认按本清单执行。** 「必须对齐」是 macOS 切换门槛；WebView 数据按下表交接。对照的是 `nsh-migration` 在 [03ba45f](https://github.com/hsingjui/pilo/tree/03ba45f) 合入 main 后的 **Tauri 桌面端与 React WebUI**，不是 M0 原型。以下均为验收要求，不代表 nsh 已实现或通过。后续合入 main 时，把新出现的桌面功能或回归用例补进对应行，记录来源提交。

本轮仅在云端 macOS 开发与验收；macOS 14 是计划的最低版本。Mac 上仍要走通 **Local 和 SSH**（SSH 是连接类型，不是桌面发布平台）；Windows / Linux 桌面、WSL 和对应打包验证延后，不删除已有运行时接口或数据。WebUI 保留 React，原有浏览器和移动端行为保持不变，唯一已批准的变化是自定义主题改用 token。功能范围以 [PRD](prd.md) 为准，里程碑见[执行计划](implement.md)。

## 必须对齐：macOS 切换前逐项验收

| 里程碑 / 区域 | 功能与通过条件 | Tauri 基线 |
| --- | --- | --- |
| M2 · 启动与导航 | [ ] 冷启动显示加载、无项目和可恢复错误状态；同一数据目录显示同样的连接、项目、会话和未读。切换项目或会话时保留正确选中项；事件重连后不漏、不重、不串会话。 | [应用](../../../src/App.tsx)、[会话导航](../../../src/components/app/use-app-chat-navigation.ts) |
| M3a · 聊天记录 | [ ] 短/长会话正确加载 Pi JSONL、按需读取较早历史；切换不闪出上一会话内容。流式时，底部跟随；往上读时保住锚点；跨 16 条消息边界、展开工具和图片迟到加载均不甩走正在阅读的内容；可一键回到底部。 | [消息视口](../../../web/components/chat/chat-conversation-viewport.tsx)、[滚动用例](../../../tests/browser/chat-scroll-following.html) |
| M3b · 回复渲染 | [ ] 流式 Markdown、代码高亮与复制、表格、外链、项目文件链接和图片预览/保存；图片用 Local 与 SSH 的项目相对路径验证，保留错误提示和路径限制。Mermaid 按下表显示源码。 | [Markdown](../../../web/components/chat/chat-markdown.tsx)、[图片](../../../web/components/chat/chat-markdown-image.tsx) |
| M3c · 工作活动 | [ ] 思考、工具输入/结果、文件变更与 diff、嵌套 agent 活动、todo 胶囊、compaction、耗时和折叠状态；实时与重新读取历史一致。 | [工作活动](../../../web/components/chat/chat-activity.tsx)、[助手工作](../../../web/components/chat/chat-assistant-work.tsx) |
| M3d · Composer | [ ] 多行、发送/换行快捷键；macOS 拼音组合中 Enter 只上屏，提交后不误发。文件/会话 `@` 提及与斜杠命令可键盘选取/关闭；文件/图片可选择、粘贴、拖入、移除；桌面输入为空时用 `↑` / `↓` 按项目回看已发送输入；同项目切换会话或新建会话时保留未发送的文字和图片，并可从当前历史条目继续翻阅，不串项目。`/new` 只消耗命令文字，保留待发图片。 | [Composer](../../../web/components/chat/chat-composer.tsx)、[输入实现](../../../web/components/chat/use-chat-composer-input.ts) |
| M3e · 模型与会话 | [x] 模型选择、thinking 档位、上下文用量和项目 Scope 默认/单会话覆盖；会话顶部菜单与 fork 从选定消息分支，原会话不变；会话压缩状态能显示。 | [会话头](../../../web/components/chat/chat-session-header-menu.tsx)、[配置用例](../../../tests/browser/chat-run-config-cache.html) |
| M3f · Pi 扩展 UI | [ ] select、confirm、input、editor 及扩展通知；支持键盘、取消/超时，切换后响应只发回发起请求的会话。 | [扩展对话框](../../../web/components/chat/pi-extension-ui-dialog.tsx)、[扩展通知](../../../web/components/chat/pi-extension-notifications.tsx) |
| M3g · 对话大纲 | [ ] 显示用户消息；鼠标和键盘可跳到当前或尚未加载的旧消息，滚动时高亮正确条目。与延后的对话内查找是两件事。 | [大纲](../../../web/components/chat/conversation-outline-rail.tsx)、[对话页](../../../src/components/chat/chat-page.tsx) |
| M3h · 发送与运行 | [ ] Local、SSH 各实跑一次：发送 → 流式回复 → 工具调用 → steer / follow-up / 立即发送 → 中止 → 切换两个同时运行的会话 → 重启后恢复历史及已有的中断/恢复提示；不重复提交。验证下一句建议与提示词增强可关闭，失败不清空输入。**待验证：** nsh 的 Local、SSH 会话共用[聊天快照与实时事件回放](../../../desktop/README.md#chat-transcripts)；SSH 需实测发起一轮、从其他会话切回及断线恢复，确认无漏字、重复或串会话。 | [运行时](../../../src/components/chat/use-chat-runtime.ts)、[队列](../../../web/components/chat/chat-pending-queue.tsx)、[发送恢复](../../../src/components/chat/use-chat-submission-recovery.ts) |
| M2 / M3 · Host 与 Pi 协作 | [ ] 不沿用 M0 禁用 agent control 的绕过；用真实 Pi 验证现有 Host 控制桥接可用。保持 `pilo-server`、protobuf、Pi RPC 和 JSONL 契约，不把项目同步到 Mac。 | [Agent control 规范](../../spec/backend/agent-control.md)、[M0 结论](../11-19-nsh-m0-risk-spikes/research/m0-conclusions.md) |
| M4 · 侧栏与项目 | [ ] 添加项目/无项目落地页、项目与临时会话入口、默认工作区可见性；项目树、最近分组、折叠/展开、调整宽度、虚拟会话行、未读/运行状态、全局搜索和命令面板；项目刷新/移除/菜单上移下移，会话刷新/重命名/删除。修改、重启后验证同样的项目顺序。 | [侧栏](../../../web/components/sidebar/app-sidebar.tsx)、[命令面板](../../../web/components/command-palette.tsx) |
| M4 · 设置 | [ ] 通用偏好、英/中文、字体和字号、应用快捷键、通知、关于；Local/SSH 新增/编辑/诊断、Pi 路径和模型目录、缓存保活、下一句建议、增强、会话命名。保存、重启、再次打开；Host 共享项在 WebUI 不被旧浏览器缓存覆盖。 | [设置面板](../../../src/components/settings/settings-dialog.tsx)、[连接设置](../../../src/components/settings/connections-settings.tsx) |
| M1 / M4 · 主题 | [ ] Lody/Claude、亮/暗/跟随系统；Tauri 桌面和 WebUI 能新建、编辑、保存、切换、删除自定义 token 主题；nsh 只提供内置主题，不再提供自定义入口，但已保存的自定义主题仍按 token 渲染。旧 CSS 有效变量自动转换；不支持的选择器列入报告；无效 token 不改变当前主题。 | [外观设置](../../../web/components/settings/appearance-settings.tsx)、[主题设计](design.md#6-主题) |
| M4 / M7 · Remote | [ ] 启停 Host、多地址/二维码配对，设备列表、续期、撤销；用已配对浏览器在原地址接续，不重配。用 React WebUI 验证历史/发送/重连、附件、Host 偏好和主题同步、移动端导航/键盘；保留现有 HTTP/WS 协议与内嵌静态资源。 | [Remote 设置](../../../src/components/settings/remote-settings.tsx)、[Remote 契约](../../spec/backend/remote-webui.md)、[移动端用例](../../../tests/browser/remote-mobile-navigation.html) |
| M5 · 工作区 | [ ] PTY 终端开关、标签、输入/输出、调大小和关闭；Git 状态与 diff、项目文件/图片/HTML 报告链接、外部编辑器和 Finder 打开；文件/Git 标签切换后回到原聊天位置，不跨项目串状态。 | [终端](../../../src/components/terminal-dock.tsx)、[工作区标签用例](../../../tests/browser/project-workspace-tabs.html)、[HTML 链接规范](../../spec/frontend/html-report-links.md) |
| M6 · 原生桌面 | [ ] 标题栏和原生窗口操作、窗口位置/大小恢复、托盘显示/恢复/退出、单实例、全局快捷键唤起、登录启动前台/后台、关闭隐藏与显式退出释放资源、有目标的系统通知点击跳到正确会话。保留可查日志和原生调试入口；不要求沿用 WebDriver 实现。 | [桌面生命周期](../../spec/backend/desktop-lifecycle.md)、[macOS 通知](../../../src-tauri/src/desktop_notifications.rs) |
| M7 · 安装、升级、性能 | [ ] 用 macOS 安装包启动，Local 对话和 SSH 对话通过；切换方案、签名/公证与更新行为按 M7 的决定验证。用隔离的 Tauri 数据副本做升级测试；同机、同一份 2,000+ 条真实历史测滚动与流式帧率/内存，不差于 Tauri。 | [发版与验收](prd.md#acceptance-criteria)、[打包设计](design.md#9-打包与发版) |

所有桌面表项同时检查键盘焦点、对话框关闭后的焦点恢复、控件可读名称、窄窗口可用性；不能以截图替代交互。浏览器回归按[测试说明](../../../tests/README.md)单独运行，含窄屏/触摸。每项交付用相应的 Rust/TS 回归测试和 `nsh test`；原生输入法、通知、安装包等用真实 macOS 补验（`nsh test --target macos` 或真实运行）。按行记录构建提交、测试名称、结果和证据。

## nsh 侧差距：切换前复核

| 项目 | 现状 | 切换前 |
| --- | --- | --- |
| 界面字号 | 未应用。Tauri 通过根字号缩放全部尺寸；nsh 0.6.0 的 `fontScale` 只读，应用不能设置文字大小。不在单个组件里模拟。 | nsh 提供设置入口后接入并验收「字体和字号」。 |
| Textarea 行距 | 在原生 Textarea 中输入的文字行距约 17pt，预置文字约 20pt；nsh 侧差距，composer 会继承。 | 复核 composer 多行输入的行距与 Tauri 一致。 |

## 已决定延后，或不移植旧实现

| 项目 | 范围 | 切换时的替代 / 验收 |
| --- | --- | --- |
| 对话内查找 | 桌面延后 | 不提供查找入口或拦截相应快捷键；大纲仍可用。 |
| Mermaid 渲染 | 桌面延后 | 以可复制的代码块显示源码；WebUI 不变。 |
| 侧栏项目拖拽排序 | 桌面延后 | 项目通过菜单「上移 / 下移」排序并保存；WebUI 不变。 |
| Windows、Linux 桌面及 WSL | 本轮延后 | 不宣称支持或通过验证；不借机删掉已有协议、连接类型和平台实现。 |
| Tauri → nsh 更新过渡 | M7 开始前单独决策 | 手动安装、验证后由旧更新器安装、或并行发布；不在 M1 默认选择，也不删除现有 macOS 更新能力。 |
| 任意 CSS 选择器、Tauri/WebView 桌面胶水 | 不移植 | 选择器出现在转换报告；托盘、窗口等原生功能用 nsh 对齐，React WebUI 保留。 |
| 仅有 API、无现有页面调用的包装 | 不新增 UI | 独立并行 Agent 管理与端口预览的 TS 包装未接入基线页面；保留运行时契约，不在本次补产品入口。普通并发会话和已有文件/报告链接仍验收。 |

## WebView localStorage 清单

相同代码可能同时运行于 Tauri WebView 和浏览器；存储按 origin 隔离。下表的「处理」只指 **旧 macOS Tauri WebView → nsh 原生桌面**，不会清理浏览器值。Host SQLite 和 Pi JSONL 不是 localStorage；不得用前端缓存覆盖已初始化的 Host 数据。缓存丢弃不等于功能丢弃。

| 键 | 当前数据 / 来源 | 切换时的处理 |
| --- | --- | --- |
| `pilo.preferences.v1` | [偏好](../../../web/lib/preferences-provider.tsx)：启动缓存；Tauri 在首次初始化时也可用它导入旧偏好。 | Host 已初始化时不复制；没有 Host 数据的旧安装先走 Tauri 的现有导入，验证后再升级，不能默默用默认值覆盖。 |
| `pilo.locale` | [语言](../../../web/i18n/locale.ts)：启动语言，参与首次 Host 偏好初始化。 | 同上，已初始化的 Host locale 优先。 |
| `pilo.theme.v1` | [主题缓存](../../../web/lib/theme-settings.ts)：包含模式、主题族、自定义 CSS 与已保存主题；旧安装可用它初始化 SQLite。 | 不复制缓存；未初始化时先让 Tauri 导入，再由 D2 转换 SQLite 中的 CSS。 |
| `pilo-ui-theme` | [模式](../../../web/lib/theme-provider.tsx)：启动快照及旧主题回退。 | 同主题缓存；不单独导出。 |
| `pilo-ui-theme-family` | [主题族](../../../web/lib/theme-provider.tsx)：启动快照及旧主题回退。 | 同主题缓存；不单独导出。 |
| `pilo.preferences.v1.legacy` | [偏好](../../../web/lib/preferences-provider.tsx)：Tauri 首次备份原值时生成，以 `.legacy` 后缀写入；没有恢复读路径。 | 不导入，不自动删除旧存储。 |
| `pilo.locale.legacy` | [偏好](../../../web/lib/preferences-provider.tsx)：同机制保存旧语言。 | 不导入，不自动删除旧存储。 |
| `pilo.boot.hasProjects` | [启动提示](../../../web/components/chat/chat-empty-hero.tsx)：根据是否有可见项目写 `0` / `1`。 | 不导出；原生界面由 bootstrap 计算。 |
| `pilo.composerSendMode.v1` | [发送模式](../../../web/lib/chat/composer-send-mode.ts)：`steer` / `follow_up` / `send_now`；不是 Host 的发送键设置。 | 保留，按枚举校验后一次性导入原生桌面偏好。 |
| `pilo.projectEditor.v1` | [项目打开方式](../../../src/lib/project-editor.ts)：已选编辑器或打开工具。 | 保留；无效值回退到默认，按当前平台/连接过滤。 |
| `pilo.sidebarWidth` | [侧栏宽度](../../../web/components/sidebar/use-sidebar-layout.ts)：像素数。 | 升级时重置，nsh 后续仍保存新宽度。 |
| `pilo.collapsedSections` | [侧栏折叠](../../../web/components/sidebar/app-sidebar.tsx)：环境/项目 ID 到布尔值。 | 保留；仅接受布尔值，忽略失效 ID。 |
| `pilo.sidebarOrganizeMode` | [侧栏视图](../../../web/components/sidebar/app-sidebar.tsx)：`projects` / `recent`。 | 保留，按枚举校验。 |
| `pilo.sidebarShowProjectsInRecents` | [最近视图](../../../web/components/sidebar/app-sidebar.tsx)：是否显示项目名。 | 保留，按 `0` / `1` 校验。 |
| `pilo.terminal.layout.v1` | [终端布局](../../../src/components/terminal-dock.tsx)：`{height}`，不含终端会话或输出。 | 升级时重置，nsh 后续仍保存新高度。 |
| `pilo.chatInputHistory.v1` | [输入历史](../../../web/lib/chat/chat-input-history.ts)：按项目保存最近 100 条文本，不是未发送草稿，可能包含敏感内容。 | 默认不导出；只在用户选择保留时在本机交接。不上传、不写日志、不跨设备同步；不从 Pi JSONL 擅自重建。 |
| `pilo.debug.chatPerformance` | [性能开关](../../../web/lib/chat/chat-performance.ts)：浏览器调试标记。 | 不导出；使用 nsh 调试入口。 |

桌面未发送的文字和图片只在当前客户端内存中按项目保留，不写入本地存储、不跨客户端同步，重启后不恢复。远程移动端保持原有的会话草稿和键盘行为。

### 仅浏览器持有：不进入桌面导出文件

| 键 | 来源 / 行为 |
| --- | --- |
| `pilo.remote.device-token.v1` | [配对 token](../../../web/remote/remote-client.ts)：同浏览器、同 origin 保持授权；不同协议/主机/端口是不同 origin。保留 Host 的配对记录和原访问地址，不拷贝、打印或导出 token。 |
| `pilo.remote.sequence.v1` | [事件游标](../../../web/remote/use-remote-connection.ts)：浏览器重连用原游标，按现有回放/刷新逻辑恢复。 |
| `pilo.remote.project.v1` | [项目选择](../../../web/remote/remote-app-model.ts)：浏览器上次选择的项目。 |
| `pilo.remote.scroll.v1.<routeSessionKey 或 draft>` | [会话滚动位置](../../../web/remote/remote-app-model.ts)：按路由保存；它既不是桌面滚动状态，也不是草稿正文。 |

`pilo.remote.pairing-context.v1` 属于 [sessionStorage](../../../web/remote/remote-pairing-model.ts)（临时配对上下文），不在清单或导出范围内。

## 数据迁移验收

- [ ] **常规升级：** 用隔离副本记录旧数据路径（Tauri bundle ID `app.hsingjui.pilo`）、连接、项目顺序、会话/未读、偏好、主题和已配对浏览器。退出 Tauri 后由 nsh 读取原有数据目录；不开两个 Host 同时写库，不复制或改写 Pi JSONL。确认现有浏览器无需重配，撤销的设备仍拒绝连接。
- [ ] **旧安装：** 覆盖「只有旧 WebView 缓存」「Host 已有不同设置」「无旧存储」「部分键无效」「重复导入及中断重试」。不能覆盖已有 SQLite 或已保存的 nsh 偏好；两端主题只转换一次，并可看到不能转换的规则。
- [ ] **本机偏好交接：** 验证发送模式、默认打开方式及侧栏视图和折叠状态保留；侧栏宽度和终端高度重置；未选择保留时不导出输入历史，选择后仅本机导入。若选择最后一版 Tauri 导出，只从当前 WebView 读取允许交接的键，不读取 WebKit 私有数据库。交接文件有版本、仅当前用户可读，导入成功后清理，旧版原存储保留。若 M7 选择不经最后一版 Tauri，必须说明如何完成旧缓存导入、何时提示用户布局重置或历史无法交接。
