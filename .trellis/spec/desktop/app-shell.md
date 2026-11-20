# 应用外壳

## 入口与边界

`desktop/App.tsx` 注册字体、初始化 i18n 并把 `Pilo` 实例交给 `launch`。`desktop/app/launch.tsx` 创建客户端和状态 store，接上桌面生命周期、通知和打开会话的订阅，再挂载 `AppShell`、初始化 Host 语言偏好，最后 `store.start()`。

| 路径                               | 职责                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `desktop/app/AppShell.tsx`         | 窗口布局、启动/失败/运行时已停止/无项目画面、工作区    |
| `desktop/app/Sidebar.tsx`          | 侧栏：项目视图、最近视图、视图菜单                     |
| `desktop/app/sidebar-projects.ts`  | 侧栏分组与排序的纯函数                                 |
| `desktop/app/sidebar-settings.ts`  | 侧栏设置，存 nsh Storage，键与 WebView 相同            |
| `desktop/app/appearance.ts`        | 已保存的语言、主题、字体                               |
| `desktop/app/open-chat.ts`         | 打开会话对应的 transcript、reducer context             |
| `desktop/app/read-open-session.ts` | 应用处于 active 时把打开会话的完成轮次标为已读         |

业务接线只放 `desktop/app`。`desktop/chat`（消息列表）、`desktop/ui`（基础组件）、`desktop/state`、`desktop/client` 由各自的任务维护；外壳缺少能力时向对应任务提出，不在外壳里复制或改写。

## 主窗口

- `desktop/nsh.json` 的 `window.restoreBounds` 由 nsh 保存和恢复窗口位置、大小与模式，并根据当前显示器调整恢复位置。没有保存状态时居中打开。窗口状态不进 Host SQLite，也不读取旧 Tauri 的窗口状态。
- `AppShell` 保留系统窗口框架和按钮，只绘制内容顶栏和拖动区。用 `WindowRef.titleBar()` 的 `left` / `right` 避开系统按钮，不按平台写死按钮宽度。
- `singleInstance: true` 由 nsh 宿主处理。再次启动、托盘显示、已注册的全局快捷键和通知点击复用主窗口的 `focus()`，由 nsh 显示窗口并恢复最小化。
- `desktop-shell.ts` 接管主窗口 `closePress`。`exitOnClose` 为 `false` 且已注册快捷键或已收到托盘操作时，普通关闭隐藏主窗口，Host 继续运行。nsh 的 `Tray.set()` 不返回安装结果；没有已知恢复途径、设置未加载或系统关闭时走退出，不让窗口藏起来无法恢复。托盘的「隐藏」是显式操作，不受 `exitOnClose` 影响。
- 托盘退出、`quitRequest` 和需要退出的关闭请求共用幂等流程：停止监听运行时事件，等 `client.shutdown()`，再 `Application.quit()`。监听 `quitRequest` 后调用 `Application.setQuitRequestOptions({ system: true })`，把 macOS 注销、重启和关机也接入该流程。不要把等待放进最终的 `quit` 事件：nsh 只为该事件提供 200 ms。
- 登录启动只读写 nsh 原生系统开关；当前 API 不提供登录启动标记，不能实现只在登录启动时后台隐藏。开发宿主和安装包的系统能力不同，不以 headless 结果代替原生验收。

## 桌面设置与会话通知

- **范围**：仅 nsh 主窗口。桌面设置不上 WebUI API，不改变 Host 事件或会话读写协议。
- **签名**：`Pilo.loadDesktopSettings() → { showShortcut, exitOnClose }`、`saveExitOnClose(enabled) → void`、`saveShowShortcut(shortcut) → void`。三者复用 `desktop_settings`，各写入只改变自己的列。`showShortcut` 缺省 `mod+alt+p`，`exitOnClose` 缺省 `false`。
- **快捷键检查**：注册前与 `desktop/shortcuts.ts` 的实际绑定比较平台键位，包括尚未启用的 `mod+enter` 发送键。拒绝冲突时不更改旧绑定或数据库；启动时发现已保存的冲突键则显示为未生效，保留原值供用户修改。
- **快捷键写入**：先注册新的键，后持久化，再释放旧键；写入使用立即事务检查已持久化的应用内快捷键冲突。系统拒绝注册不写库，数据库拒绝保存只释放新键，保留旧键和原设置。相同的物理键不重复注册。
- **通知契约**：只消费新于 bootstrap 序列的 `assistant_message_end` 会话事件，跳过主动取消和没有已保存路径的会话。尊重 `desktopNotifications`，不在事件处理时申请权限。通知 ID 形如 `pilo-session:` 加 JSON `[projectId, sessionPath]`，同一会话的新通知替换旧通知；点击通知（包括冷启动）等待项目加载及会话索引确认路径后再导航。无效通知 ID、已删除会话或未确认路径不会改变导航。
- **验收**：原生窗口拖动、调整大小、最小化/最大化；普通和最大化状态分别退出重开，再拔副屏重开；从托盘、快捷键和二次启动恢复窗口；占用新快捷键时旧键仍生效；隐藏时 Pi 继续工作，显式退出时 Host 清理；有目标的通知在窗口隐藏和冷启动时打开正确会话，关闭通知开关、主动取消或目标已删除时不产生错误跳转。
- **错误示例**：先释放旧快捷键再尝试注册新键会在注册冲突时丢失恢复入口。正确做法是 `register(next) → saveShowShortcut(next) → unregister(previous)`；保存失败则仅 `unregister(next)`。

## 打开会话的 transcript

`followOpenSession` 按下面的顺序决定 `ChatTranscriptStore.open({ sessionKey, projectId, sessionPath }, connected)` 的目标，这是与聊天部分的契约，发起聊天时必须使用同一个 key：

1. 应用状态 `chatSessions` 中有同一项目、同一会话路径的聊天：用它自己的 `sessionKey`。
2. 否则用会话索引条目的 `chatSessionKey(projectId, piSessionId)`（`src/lib/api/chat-session-key.ts`）。
3. 没有选中会话，或索引里没有该会话：`close()`。

目标不变时不重新打开。导航里已打开但还没有目标的会话（索引未读到或已不在索引）显示空工作区。测试见 `desktop/tests/open-chat.test.ts`。

## 工作区

- 没有打开会话：项目页。
- 打开会话：`ChatMessageList`，`transcript`、`messages` 来自 transcript store，`onRetry={() => chat.refresh()}`，`empty` 槽由外壳提供。
- `onVisibleRangeChange={(start, end) => chat.loadRange(start, end)}`：列表上报可见范围，transcript store 按范围加载更早历史。
- 列表尚未提供的其他能力不在外壳里预先接线。

测试见 `desktop/tests/workspace-chat.test.ts`：已保存历史、空会话、读取失败后重试。

## 已读标记

打开会话里有轮次结束时，只有应用处于 active（`lifecycle() === "active"`，对应 Tauri 的文档可见且有焦点）才立即标为已读；否则保持未读，回到 active 后再标。状态以运行时的 read-state 事件为准，不以调用返回为准。

```ts
// 错误：selectSession 还会写导航
store.selectSession(open.projectId, open.sessionPath);

// 正确：只确认打开会话已完成的轮次
store.acknowledgeOpenSession();
```

`AppStore.selectSession` 自身也调用 `acknowledgeOpenSession()`。测试见 `desktop/tests/app-store.test.ts`、`desktop/tests/read-open-session.test.ts`。

## 外观

- 语言、主题从应用状态读取并应用；字体见 `desktop/README.md` 的 Saved fonts：页面字体写入 `font-sans`，代码字体写入 `font-mono`，代码字号写入 `pilo-code-font-size`。
- 颜色用 token。只在暗色生效的变体用 `dark:` class；颜色是值而不是 class 时用 `colorScheme()`。例：暗色下未选中的侧栏行为前景色的 75%，与 Tauri 相同。
- 不在单个组件里模拟界面字号缩放，见下方差距。

## 侧栏

- 设置键与默认值沿用 WebView（`pilo.collapsedSections` 等；`env:` 分组默认展开，`ws:` 默认折叠），清单见[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md#webview-localstorage-清单)。
- 项目视图：按连接分组，本地在前；展开项目时读取会话，运行中的在前，再取最近五条，其余由「查看全部」原地展开。排序复用 `src/components/sidebar/session-list.ts` 的 `summarizeProjectSessions`。
- 最近视图：所有项目的会话合并，运行中的在前，再取最近 50 条，复用 `sortSidebarSessionsActiveFirst`。

## 测试约定

- 外壳 fixture 使用 `desktop/tests/scripted-app-client.ts`，不启动运行时；真实运行时只用于启动测试和一次性证据。
- 按下之后先等待它引起的结果，再断言；不 sleep，不重复按。
- `nsh test --target macos` 的应用在后台运行，不会成为 active 应用：`lifecycle()` 为 `inactive`，`app.setLifecycle` 只有 headless 支持（`ERR_NSH_TEST_UNSUPPORTED`）。需要 active 时加 `--foreground`，应用从第一次按下起为 active：

  ```bash
  cd desktop
  nsh test --target macos --foreground tests/read-open-session.test.ts
  ```

- 单个测试不能超过 30 秒。
- `app.viewStyle` 不返回文字颜色；文字颜色的改动用原生窗口截图证明。
- 测试参数经 `open(..., { host: { params } })` 传入，fixture 读 `host.params`。
- macOS 下应用内的 `console.log` 不会转到测试输出；需要时写入 Storage，再用 `app.storage()` 读取。

## 尚未对齐

nsh 侧的两项已登记在[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md#nsh-侧差距切换前复核)。外壳自身的差距：

- 侧栏宽度拖动等待 `ResizeSeparator`。
- 没有 composer 和会话头。
- 阅读字体、终端字体由聊天和终端部分读取，外壳不应用。
- 侧栏：分组来自项目的连接，没有项目的连接不显示；默认工作区显示已存名称；连接菜单只有视图项；没有悬停箭头、tooltip 和行菜单；「查看全部」原地展开，Tauri 打开单独的列表；会话读取失败的项目不出现在最近视图，也不提示错误；运行时停止时侧栏为空。
