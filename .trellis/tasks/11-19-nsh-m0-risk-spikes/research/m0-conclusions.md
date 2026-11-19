# nsh 迁移 M0：四项风险的结论

实测环境：macOS 26.6.2（arm64 虚拟机，60 Hz 显示器），nsh 0.6.0 (5541637)，Pi 1.5.2，debug 构建。
代码在 `desktop/`（nsh 应用）与 `src-tauri/src/runtime/nsh_spike.rs`（运行时入口）。
截图在 `evidence/`，逐步的过程记录（含走过的弯路）在 `working-notes.md`。

**Windows 一项未运行**：用户在 M0 进行中决定先不做 Windows 验证，因此第 2 项和第 3 项的 Windows 部分没有任何结论。下文所有“通过”都只指 macOS。

## 总表

| # | 风险 | macOS | Windows | 建议 |
|---|---|---|---|---|
| 1 | Rust 运行时接入 | 通过 | 未运行 | 继续 |
| 2 | Windows 原生窗口与安装包 | 不适用 | 未运行 | 待定：发版平台是 Windows，进入 M3 之前需要补做 |
| 3 | Composer 输入 | 通过（`Input` 与 `RichEditor` 都通过） | 未运行 | 继续，选 `Input`；Windows 输入法需补做 |
| 4 | 共享 TS 逻辑 | 有条件通过 | 与平台无关 | 继续，M1 拆出纯类型文件 |

## 1. Rust 运行时接入：通过（macOS）

做了什么：

- `desktop/native` 以 path 依赖链接现有 `pilo` crate（`src-tauri`），导出类 `Pilo`（`desktop/native/src/pilo.rs`）。它只调用运行时已有的代码：`storage::list_projects` / `list_sessions`、`chat_service::start`、`chat_sessions.send` / `stop`、`RuntimeEventBus::subscribe_web`。
- nsh 窗口列出 Tauri 开发版写入的同一个 `pilo.sqlite3` 里的项目与会话（`evidence/m0-1-nsh-macos-session-list.jpg`，对照 `m0-1-tauri-dev-session.jpg`）。数据走 Rust 模块，不经 HTTP。
- 在 nsh 窗口输入提示词，经 `chat_service::start` → 本地 `pilo-server` → `pi --mode rpc`，流式事件经共享的 `toConversationAction` + `reduceConversation` 渲染为消息列表；回合结束后新会话出现在侧栏（`m0-1-nsh-macos-real-pi-stream.jpg`）。

数据（延迟 = Rust 从事件总线读到事件 → JS 收到，同一个 Rust 时钟两端取值）：

| 场景 | 事件数 | 延迟 p50 / p95 / max | 帧 | 截图 |
|---|---|---|---|---|
| 真实 Pi 对话（中转模型，回复 1–40） | 13 | 0.21 / 1.34 / 1.34 ms | 丢帧 0% | `m0-1-nsh-macos-real-pi-stream.jpg` |
| 合成 300 条 @ 100/s | 302 | 0.14 / 0.54 / 0.97 ms | 丢帧 0% | `m0-1-nsh-macos-burst-300.jpg` |
| 合成 3000 条 @ 1000/s，每批写一次 signal，整条回复一个 `Text` | 3002 | 4.26 / 16.88 / 27.03 ms | 丢帧 26%，CORE p95 22.9 ms | `m0-1-nsh-macos-burst-3000.jpg` |
| 同上，每帧写一次 signal | 3002 | 0.16 / 15.87 / 26.49 ms | 丢帧 14.2%，CORE p95 20.1 ms | `m0-1-nsh-macos-burst-3000-coalesced.jpg` |
| 同上，每帧写一次 + 文本按 400 字符分块 | 3002 | 0.12 / 2.79 / 5.74 ms | 丢帧 0%，CORE p95 1.27 ms；负载中 57/60 fps | `m0-1-nsh-macos-burst-3000-chunked.jpg`、`m0-1-nsh-macos-burst-3000-chunked-midburst.jpg` |

读法与局限：

- 真实对话只有 13 个事件（中转一次给一大段），所以高频数据来自合成突发。合成事件发布在真实的 `RuntimeEventBus` 上，走与真实事件相同的路径，但不经过 `pilo-server` 和 Pi 进程。
- 每个场景只跑了一次，debug 构建，一台机器。数量级可信，具体数值不要当基准。
- 丢帧的原因已定位并消除：整条回复放在一个文本节点里，每次增量都重排全文，开销随消息长度增长。分块后只重排末尾节点。

对后续的约束（M1–M3 要遵守）：

1. **流式文本不能放在单个文本节点里**，信号每帧最多写一次。Markdown 分块渲染天然满足前者。
2. **`nsh_core::background()` 不能在同步调用里用**（类的构造函数会 panic：`there is no reactor running`）。它就是 `tokio::spawn`，只有 async 成员在 Tokio 上下文里。`Pilo` 因此自带一个多线程 Tokio runtime。`design.md` 第 4 节原写法已改。
3. **Agent control 依赖 `AppHandle`**（`server_pi.rs` 调 `servers.control_app()`，`runtime/control::attach(app, …)`）。默认的对话启动会因此失败（`Pilo Host control is unavailable`）。M0 用 `ServerManager::disable_agent_control()` 跳过，nsh 版目前没有 agent control；M1 抽离清单要加上这个子系统。
4. **本地 `pilo-server` 的启动方式**：Tauri debug 版靠 `current_exe() --pilo-server`，nsh 宿主进程不认这个参数。M0 加了 `initialize_local_server_binary`，指向单独构建的 `target/debug/pilo-server`。打包时要把这个二进制放进 nsh 应用的资源里。
5. **会话列表只读了 SQLite 缓存**。`session_index::reconcile` 仍要 `AppHandle`，M0 没接，所以截图里消息数是 0。
6. **Tauri 仍被整体链接进 nsh 应用**（未使用）。构建产物很大：一小时内 `desktop/target` 涨到 24 GB、`desktop/native/target` 9.3 GB，把磁盘写满过一次；清空后一套干净产物约 15 GB。原因是 nsh 为原生 crate、开发宿主、无头测试宿主各编译一遍整棵依赖树。M1 去掉 Tauri 依赖后会明显变小，在那之前需要定期清理。

未验证：`design.md` 第 4 节的“`Image` 能否直接接收 Rust 返回的字节或本地路径”。M0 没有涉及图片，这一条仍是待验证。

## 2. Windows：未运行

没有任何数据。Windows 是 Pilo 的首要发布平台，这项不通过的话前面的结论都不足以支撑迁移，建议在投入 M3（Chat）之前补做：原生窗口、微软拼音、`nsh package` 的安装/覆盖升级/卸载、托盘、全局快捷键、单实例。

已知与 Windows 有关的一点（读源码得到，未运行）：`InputRef.insertText` 在 nsh 0.6.0 的 Windows 后端同样没有实现（`nsh-platform-windows/src/mount.rs:472`，只打一条日志）。

## 3. Composer：通过（macOS），选 `Input`

`desktop/Composer.tsx` 并排放了两种实现，用系统拼音（简体）实测。两种在 macOS 上全部通过：

| 检查项 | `Input`（多行） | `RichEditor` |
|---|---|---|
| 中文输入法组合、候选窗在光标下 | 通过 `m0-3-macos-input-ime-composition.jpg` | 通过 `m0-3-macos-rich-ime-user-switch.jpg` |
| 组合中按 Enter 只上屏、不发送 | 通过 `m0-3-macos-input-ime-commit.jpg` | 通过 `m0-3-macos-rich-ime-return-commits.jpg` |
| `@` 触发、弹层跟随光标 | 通过（`onCaretMove` 的 `pageBounds` 作 `Overlay` 锚点）`m0-3-macos-input-mention-popup.jpg` | 通过（`suggestion` 插件 + `bubbleMenu`）`m0-3-macos-rich-mention-popup.jpg` |
| 方向键 / Tab / Esc 操作弹层 | 通过（`keymap.bind(…, { when: "always" })`，仅弹层显示时绑定）`m0-3-macos-input-arrow-keys.jpg` | 通过（`captureKeys`） |
| 插入提及后继续输入、发送 | 通过 `m0-3-macos-input-tab-escape-send.jpg` | 通过，且能从文档取出结构化提及 `m0-3-macos-rich-send.jpg` |
| `@` 查询里输入中文 | 通过 `m0-3-macos-input-ime-mention-send.jpg` | 通过 `m0-3-macos-rich-ime-mention-send.jpg` |
| 粘贴图片 | 通过（`onPaste` 的 `files`，72,594 B PNG） | 通过（`onPasteFiles`）`m0-3-macos-rich-mention-paste.jpg` |
| 从 Finder 拖入文件 | 通过（外层 `View` 的 `onFileDrop`） | 通过（`onFileDrop`）`m0-3-macos-file-drop-both.jpg` |
| Enter 发送、Shift+Enter 换行 | 通过（`submitBehavior="submit"`） | 通过（`RichEditorPlugin` 捕获 Enter） |

选 `Input` 的理由：

- 现有 Composer 是 `Textarea` 加文本形式的提及（`src/lib/chat/chat-mentions.ts`：文件提及就是 `@"path"` 文本）。`Input` 是同一种模型，这部分纯逻辑可以原样复用；`RichEditor` 是文档模型，需要另写文档 ↔ 文本的转换。
- `RichEditor` 的 `starterKit()` 带 Markdown 输入规则和富文本标记，提示词输入框不需要，得自己裁一份最小 schema。
- `RichEditor` 的输入法走一个隐藏的 1px 原生输入框，比 `Input` 多一层，在 Windows 上多一个要验证的点。

`Input` 的已知限制：

- `InputRef.insertText` 在 macOS 和 Windows 上没有实现（nsh 0.6.0，`nsh-platform-macos/src/mount.rs:740`）。插入提及只能改写受控的 `value` 再 `setSelection`，这一步不进入原生撤销栈。Linux 后端有实现。
- macOS 默认会自动纠正/首字母大写，需要 `autoCorrect={false}`、`autoCapitalize="none"`。
- 输入法组合期间，组合中的文本还不在 `value` 里，弹层会显示全部候选，上屏后才过滤（两种实现表现相同）。

如果以后需要行内的提及徽标（不是纯文本），再换 `RichEditor`，它在 macOS 上是可用的。

一处测试方法的教训：中途一度看到 `RichEditor` 里拼音不组合，实际是用 `TISSelectInputSource` 从别的进程切换输入源，前台应用没生效（`m0-3-macos-rich-ime-broken-repro.jpg`；切到别的应用再切回来就恢复，`m0-3-macos-rich-ime-after-reactivation.jpg`）。用菜单栏切换则一直正常。`desktop/spikes/RichMinimal.tsx` 的五种配置都能组合（`m0-3-macos-rich-variants-ime.jpg`）。

## 4. 共享 TS 逻辑：有条件通过

通过的部分（`desktop/spikes/*.test.ts`，`nsh test` 5 个测试全过）：

- nsh 打包器能导入 `desktop/` 之外的文件（相对路径与 `@/` 别名解析到同一个模块）。
- 别名要写在 `nsh.json` 的 `resolve.alias` 里；`tsconfig` 的 `paths` 只管类型检查，不影响打包。
- 根目录 `node_modules` 里的纯 TS 依赖（`i18next`）能被打包。
- `conversation-reducer`、`conversation-replay`、`conversation-runtime-adapter` 在 nsh 里直接运行，历史事件回放和实时事件都能得到正确的消息列表；第 1 项的真实对话走的也是这条路径。

条件：

- 纯逻辑的**类型**依赖图会伸到 React/DOM/Tauri 模块，`nsh check` 会报错。已做两处最小抽取让 reducer 干净：`src/lib/chat/chat-activity-types.ts`（原先定义在 `chat-activity.tsx` 里）和 `src/i18n/instance.ts`（不带 React 绑定的 i18next 实例）。
- `PiloRuntimeEvent`（`src/lib/api/pi-runtime-types.ts`）还没拆干净：它引用的设置类型分散在 `host-preferences.ts`、`next-prompt.ts`、`prompt-enhancement.ts`、`theme-settings.ts`、`api/sessions.ts` 等带 DOM 或 Tauri 代码的文件里（62 个类型错误）。M0 用 `desktop/types/conversation-runtime-adapter.d.ts` 加一条精确的 `paths` 顶替类型，运行时加载的仍是真实模块。M1 需要把这些类型移到纯 `*-types.ts` 文件。
- reducer 用到 i18next，但 nsh 应用没有走现有的 `initializeI18n`（它绑定了 React 和 `window`）。桌面端要自己用资源对象初始化，否则 reducer 的错误文案会是 key。
- 根目录的 `oxlint` 是按 React/DOM 配的，对 nsh TSX 会误报（`Each` / `If` 未定义等），已把 `desktop/**` 加进忽略；nsh 代码由 `nsh check` 检查。`oxfmt` 仍然格式化 `desktop/`。

## 对 Tauri 版的影响

为接入改了 `src-tauri` 的 7 个文件并新增 `nsh_spike.rs`，都是新增入口，默认行为不变：`HostPaths::new`、`initialize_local_server_binary`（未设置时走原分支）、`ServerManager::disable_agent_control`（默认启用）、`nsh_spike` 模块。`src/` 改了 6 个文件、新增 2 个，都是把类型或实例的导入换到新抽出的纯文件。

验证：`pnpm format`、`pnpm check`、`pnpm build`、`cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo test -p pilo --lib`（189 通过）、`nsh check`、`nsh test`（5 通过）。Tauri 开发版在这些改动下能编译并启动；改动之后没有再在 Tauri 窗口里重新跑一次对话。

## 复现

```sh
cargo build -p pilo-server                 # 本地 pilo-server，Pilo 类默认找 target/debug/pilo-server
cd desktop
nsh check && nsh test                      # 无头；默认读开发版数据目录，PILO_DATA_DIR 可改
nsh run --fps                              # 第 1 项：列表、真实对话、Burst 按钮
nsh run Composer.tsx                       # 第 3 项：两种 Composer
nsh run spikes/RichMinimal.tsx             # 第 3 项的对照
```

数据目录默认与 Tauri 版一致（debug 构建是 `app.hsingjui.pilo.dev`），可用 `PILO_DATA_DIR`、`PILO_SERVER_BINARY` 覆盖。
