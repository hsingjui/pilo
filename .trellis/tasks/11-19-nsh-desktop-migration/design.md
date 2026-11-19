# 桌面端迁移到 nsh · 技术设计

标注为“待 M0 验证”的内容来自 nsh 文档，尚未实测；M0 结论会回写本文件。

## 1. 目标架构

```text
nsh TSX UI（desktop/）            React WebUI（src/remote/，不变）
      ↓ app/native（Rust 模块）          ↓ HTTP / WebSocket
pilo-desktop（nsh 壳，Rust）        Remote API（Axum，已有）
      └──────────────┬──────────────────┘
               pilo-runtime（现有 src-tauri/src/runtime，去掉 Tauri 依赖）
                     ↓
       Connection Layer → Pi RPC → pi --mode rpc
```

- 两个界面共用同一个 Rust 运行时和事件总线，与现在 Tauri 桌面端 + WebUI 的关系相同。
- 桌面界面直接调用 Rust 模块，不经过 Remote HTTP 接口。

## 2. 目录布局

```text
crates/
  pilo-protocol/        不变
  pilo-server/          不变
src-tauri/              过渡期保留原路径：runtime/ 与 domain/ 去掉 Tauri 依赖后可单独编译；
                        Tauri 壳、command 胶水、插件接线放在 `tauri` feature 之后
desktop/                新：nsh 应用
  nsh.json  theme.json  App.tsx
  native/               Rust crate（pilo-desktop）：#[native_module("app/native")]，依赖 pilo-runtime
  app/ chat/ sidebar/ settings/ ui/ lib/      TSX 与 signal 状态
  tests/                *.test.tsx（nsh test）
src/                    保留：WebUI 及其用到的共享组件、src/lib 纯逻辑
```

目录名 `desktop/` 为暂定名。M7 切换发版时把 `src-tauri/src/runtime` 与 `domain` 搬到 `crates/pilo-runtime`，删除 Tauri 壳以及 `src/` 中只被桌面端使用的文件。

## 3. Rust 运行时抽离

抽离只在 `nsh-migration` 分支进行，`main` 不动（PRD Decisions）。`main` 仍在修改 `src-tauri/src/runtime`（例如会话历史增量加载），因此：

- **不移动文件**。在原路径上去掉 Tauri 依赖，`desktop/native` 以 path 依赖引用 `src-tauri` 这个 crate 的库（关闭 `tauri` feature）。文件搬迁推迟到 M7，那时 `main` 已不再独立演进。
- **改动尽量是替换而非重排**：把 `AppHandle` 参数换成运行时自己的句柄类型，不调整函数顺序和模块结构，让 `main` 的改动能按行合入。
- 每次合入 `main` 后，在分支上同时验证 Tauri 版（`cargo check`、`pnpm build`）和 nsh 版。
- `main` 上新增或修改的 Tauri command，登记到“待同步清单”，在 `Pilo` 模块补上对应方法。

现状耦合点（均已在仓库中确认）：

| 耦合 | 位置 | 抽离方式 |
|---|---|---|
| `AppHandle` 取路径 | `host_paths.rs`、`storage/schema.rs`、`server_deploy/target.rs` 等 | `HostPaths` 改为由壳在启动时传入数据目录和资源目录 |
| `AppHandle` 发事件 | `session_watcher.rs`、`terminal.rs`、`desktop_notifications.rs` | 定义 `HostEvents` trait（`emit(name, payload)`），Tauri 壳和 nsh 壳各自实现 |
| `app.state::<T>()` / `State<T>` | command 层 198 处 | 运行时状态收拢到一个 `Runtime` 句柄，壳持有并传给 command / 模块函数 |
| `tauri::async_runtime::spawn(_blocking)` | 18 处 | 换成 `tokio::spawn` / `spawn_blocking`（运行时自带 Tokio handle） |
| `asset_resolver()` 提供 WebUI 资源 | `runtime/remote/api/mod.rs:256` | 定义 `WebAssets` trait；nsh 壳用内嵌目录实现（`include_dir` 一类），Tauri 壳沿用 resolver |
| `tauri::ipc::Response` 二进制返回 | 历史图片读取 | 运行时返回 `Vec<u8>`，由壳决定编码 |

抽离本身不改变行为，可独立验证：`cargo test`、分支上的 Tauri 版手动回归。127 个 command 的函数体改为调用运行时的同名函数，command 只剩参数解包。下文的 `pilo-runtime` 指去掉 Tauri 依赖后的这部分代码，M7 之前它仍位于 `src-tauri/src/runtime`。

## 4. 桥接契约（TSX ↔ Rust）

- `desktop/native` 导出模块 `Pilo`，方法集合 = `PiloClient` 接口（`src/lib/api/pilo-client.ts:72`）+ 桌面专属 API（项目、连接、SSH、终端、文件、并行、预览）。
- 每个方法是 `async fn`，在 `background(…)` 中调用 `pilo-runtime`（Tokio）。参数与返回值用 `#[derive(JsObject)]` 结构体，TypeScript 声明由 nsh 从 Rust 生成，取代手写的 `pi-runtime-types.ts` 桌面部分。
- 事件：`Pilo.on("runtime", listener)` 返回停止函数，承载 `PiloRuntimeEvent`（含 `sequence`）；`session_watch`、`terminal`、`notification_open_session` 各一个事件名。
- 高频流式增量在 Rust 侧按帧合并后再回调，避免每个 token 一次跨线程（nsh 性能规则：JS 做得越少越好，跨线程要成批）。合并粒度在 M0 用真实 Pi 会话测定。
- 二进制（历史图片、项目图片）：待 M0 验证 nsh 的 `Image` 能否直接接收 Rust 返回的字节或本地缓存路径。
- TSX 侧保留 `PiloClient` 这层接口，实现为 `nshPiloClient`，这样 `src/lib` 里依赖 `PiloClient` 的纯逻辑可以原样使用。

## 5. 界面层对应

| 现有（React） | nsh | 备注 |
|---|---|---|
| Zustand store、`useSyncExternalStore` 外部 store | 模块级 `signal` / `computed` | `chat-conversation-store`、`chat-draft-store` 等按 store 逐个改写 |
| TanStack Query | signal + 显式加载函数 | 缓存失效由事件驱动，与现在一致 |
| React hooks（`components/chat` 下 26 个 `use-*` 文件） | 工厂函数返回 signal 与动作 | 迁移工作量的主体 |
| `src/lib/chat/*` 纯逻辑（29 个文件 4,388 行） | 直接导入复用 | 待 M0 验证 nsh 打包器能否导入 `desktop/` 之外的 TS 文件；不能则抽成共享包 |
| streamdown + Shiki | `TextView`（流式、代码高亮、表格、公式） | Mermaid 无对应 |
| `@pierre/diffs` | `DiffView` | 需按行数计算高度 |
| xterm | `Terminal` | PTY 仍由 `runtime/terminal.rs` 提供 |
| Radix（Dialog / Popover / Menu / Tooltip / Tabs / Select） | `nsh/base` 同名组件 | 无样式，样式用 Tailwind 类重写 |
| cmdk | `Command` | |
| dnd-kit（项目排序） | 无高层 API | 用 pan 手势自实现，或先用菜单“上移/下移”替代 |
| 虚拟列表（自研 `chat-virtualization`） | `List` | `maintainVisibleContentPosition` 取代粘底逻辑 |
| lucide-react | `Canvas` 绘制路径数据 | 构建期脚本从 `lucide-react` 生成 |
| i18next 资源（`src/i18n/resources/*.ts`） | `nsh/i18n` 或直接复用资源对象 | 待 M1 确认插值与复数写法是否兼容 |
| Textarea + 自研 mention | `Input` 或 `RichEditor`（mention 扩展） | M0 决定用哪一个 |
| `chat-find-bar` 对话内查找 | 无对应 | 需自实现或延后 |

## 6. 主题

- `desktop/theme.json` 是 Lody 基础主题（shadcn 风格 token + Pilo 自有 token：`sidebar`、`hover`、`bubble-radius`、`composer-radius` 等）。
- 主题族切换 = 基础主题与该族 token 表合并后 `setTheme`；亮/暗用 `setColorScheme`。
- `ThemeSettings` 结构（`theme`、`themeFamily`、`savedCustomThemes`）保留，存储位置不变；自定义主题内容由 CSS 文本改为 token 表（取决于 PRD Open Question 2）。
- 构建期脚本从 `src/styles/lody-theme.css`、`claude-theme.css` 生成 token JSON，保证 WebUI 与桌面端同源。
- 用户输入的 token 先校验再应用（无效值会让 `setTheme` 整体失败）。

## 7. 桌面壳

| Tauri | nsh | 状态 |
|---|---|---|
| `tauri-plugin-single-instance` | `nsh/desktop` 单实例 | 待验证 |
| `tauri-plugin-global-shortcut` | `GlobalShortcut` | 待验证 |
| `tray-icon` | `Tray` | 待验证 |
| `tauri-plugin-autostart` | 开机启动（Opening at login） | 待验证 |
| `tauri-plugin-window-state` | 窗口状态与显示器 API | 待验证 |
| `tauri-plugin-notification` + `tauri-winrt-notification` | nsh 系统通知；点击跳转会话需验证 | 待验证 |
| `tauri-plugin-opener` | 标准模块打开链接/文件 | 待验证 |
| `tauri-plugin-updater` + `process` | `nsh/updater` | 清单与签名格式不同，见第 9 节 |
| `tauri-plugin-log` | `log` crate + 文件输出 | 沿用 `tracing` |
| `tauri-plugin-wdio-webdriver`（`pnpm debug:desktop`） | `nsh test --target` | 调试脚本改写 |
| 自定义标题栏（`title-bar.tsx`） | `nsh/desktop` `titleBar` | 待验证 |

## 8. 数据与兼容

- 数据目录沿用 Tauri 版路径（各平台按 `app.hsingjui.pilo` 解析出的目录），由 nsh 壳显式计算后传给 `pilo-runtime`，不依赖 nsh 的应用 id 默认目录。
- SQLite schema、偏好、主题设置、Remote 配对数据不迁移、不改格式。
- WebView `localStorage` 中的数据（如 `pilo.theme.v1` 主题缓存、草稿）在 nsh 版读不到：M1 列出所有键，逐个决定丢弃或在最后一个 Tauri 版本里导出到数据目录。

## 9. 打包与发版

- 新增 release 流水线：`nsh package --target windows|macos|linux`，WebUI 仍先 `pnpm build` 再内嵌。
- Windows：Inno Setup 每用户安装器；代码签名沿用现有方式（如有）。
- macOS：`.app` 需自行签名、公证并打成发布包。
- Linux：nsh 只产出目录与 `tar.gz`；`deb` / `rpm` / `AppImage` 取决于 PRD Open Question 1。
- 自动更新：`nsh/updater` 读取 nsh 格式清单。Tauri 版 → nsh 版的过渡取决于 PRD Open Question 4，候选做法：最后一个 Tauri 版本提示用户手动下载；或让 Tauri 更新器下载并运行 nsh 安装器（待验证）。
- 版本号继续由 `Cargo.toml` `[workspace.package].version` 驱动，`nsh.json` 的版本由脚本同步；发版前仍需向用户确认版本号。

## 10. 测试

- TSX：`nsh check`（类型）+ `nsh test`（无界面交互测试）+ `nsh test --target macos|windows`（原生截图与真实输入）。
- Rust：`pilo-runtime` 保持现有单元测试；`desktop/native` 的模块函数用 nsh 的 Rust 测试入口。
- 纯逻辑：`src/lib` 的现有 `tests/unit` 继续由 Node 运行，两端共用。
- 每个里程碑提供一组原生截图与 Tauri 版对照，存入对应子任务的 `research/`。

## 11. 过渡期规则

- `AGENTS.md` 的“两端共享同一套组件”改为过渡期说明：`main` 上的 UI 改动仍按 React 两端共用；迁移分支每次合入 `main` 时，把期间桌面端可见的改动登记到“待同步清单”，在对应里程碑内补到 nsh 界面。
- `nsh-migration` 至少每周合入一次 `main`，冲突在迁移分支上解决；迁移分支不向 `main` 回合任何改动，直到 M7。
- 迁移分支对 `src-tauri/src/runtime` 只做去 Tauri 依赖的改动，不改业务逻辑；业务修复一律先进 `main` 再合入。
- nsh 版本固定到具体 release，升级 nsh 单独提交并跑全量 `nsh test`。

## 12. 风险与回退

| 风险 | 影响 | 应对 |
|---|---|---|
| nsh 仅 5 周，API 变动 | 升级成本、未知缺陷 | 固定版本；缺陷先在应用内绕过并记录；M0 设止损点 |
| Windows 未验证 | 首要发布平台 | M0 第二项，未通过即中止 |
| 输入法与 `@` 提及 | Composer 是核心交互 | M0 第三项 |
| Tokio 运行时与 nsh 任务协作 | 桥接方案是否成立 | M0 第一项 |
| 双份 UI 维护 | 迁移期间成本 | 待同步清单；缩短迁移周期 |
| 运行时只在分支上抽离，`main` 持续改同一批文件 | 每次合入都可能冲突 | 不移动文件、替换式改动、每周合入、合入后双版本验证 |
| Linux / macOS 支持范围收窄 | 部分用户无法升级 | PRD Open Question 1 |
| 无 Mermaid、查找、拖拽排序 | 功能回退 | PRD Open Question 3；必要时用 `WebView` 承载 Mermaid（待验证） |

回退：切换发版前 Tauri 版本始终可发；切换后保留 `src-tauri/` 一个版本周期再删除。
