# 应用外壳

## 入口与边界

`desktop/App.tsx` 只注册字体、初始化 i18n 并调用 `launch(new Pilo())`。`desktop/app/launch.tsx` 依次创建 `NshPiloClient`、`ChatTranscriptStore`、`AppStore(client, chat)`，接上 `followOpenSession(store, chat)` 与 `followOpenSessionRead(store)`，再 `mount(AppShell, { store, chat })`，把已保存的界面语言写入 Host 偏好（`client.savePreferences`），最后 `store.start()`。

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
