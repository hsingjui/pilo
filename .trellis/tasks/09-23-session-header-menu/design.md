# Session Header Menu — 技术设计

## 边界

- **前端为主**：菜单、查找条、重命名对话框全部在前端；唯一后端改动是 Tauri capability（新窗口权限）。
- 不改 Pi RPC、不改 SQLite schema、不改 `session_*` command 行为。
- 新窗口复用现有 `openSearchSession(target)` 通路定位会话，不新增会话加载逻辑。

## 契约

### `SessionHeader` 新增 props（全部可选，向后兼容）

```ts
onRenameSession?: (title: string) => void;
onFindInSession?: () => void;
onOpenInNewWindow?: () => void;
```

- 传入才渲染对应菜单项；`onFindInSession` 由 `ChatPage` 提供（查找状态归 `ChatPage`）。
- `new-chat-landing.tsx` 无 `session`，不渲染菜单。
- `chat-page-loading-fallback.tsx` 有 `session`，只渲染 ID/路径复制项。

### 会话 ID / 路径

- ID：`session.id`；路径：`session.sessionPath`。
- 复制走现有剪贴板通路（`navigator.clipboard.writeText`，与其它复制按钮一致），成功后 `toast`。

### 重命名

- `ChatPageProps.onRenameSession?: (title: string) => void` → `App.tsx` → `useAppChatWorkspace.updateSession(session.id, { title })`。
- 菜单内使用 `Dialog` + `Input` 收集标题，`trim` 后非空且与原值不同才提交。
- 草稿会话（`!session.sessionPath` 且非临时）其实仍是「新会话草稿」，禁用重命名。

### 在当前会话中查找

- `ChatPage` 持有查找状态：`findOpen`、`findQuery`、`activeMatchIndex`。
- 匹配来源：`ChatPage` 已有的 `messages`（`ChatMessage[]`）。对每条消息取纯文本（复用 `conversation-outline.ts` 的纯文本思路，导出 `plainText`/封装一个 `messageSearchText`）。
- 匹配模型：`{ messageIndex, start }[]`（同一消息内多个命中各算一条）。
- 跳转：在 `ChatConversationViewportHandle` 上新增 `scrollToMessageIndex(index, offsetPx?)`，底层复用 `use-chat-scroll-controller.ts` 的 jump 逻辑（把 `handleOutlineJump` 内「设置 pending + scrollMessageToTop + drift 校验」抽成 `jumpToMessageIndex(messageIndex)`）。
- 高亮：向 viewport 传 `highlightMessageId?: string`，`MessageRow` 增加 `highlighted?: boolean`，命中时加 `ring` 样式；仅高亮当前活动命中。
- 打开方式：菜单项 + 快捷键。快捷键用 `useKeyboardShortcut("mod+f", ...)`（需确认 `keyboard-shortcuts.ts` 对 `mod+f` 的支持；若不支持则用原生 keydown 监听 `(e.metaKey||e.ctrlKey)&&e.key==='f'`）。
- 关闭：Esc / 关闭按钮，关闭时清除 `highlightMessageId`。

### 在新窗口打开会话

- 新增 `src/lib/window.ts`：`openSessionInNewWindow({ projectId, sessionId, sessionPath, title })`，用 `new WebviewWindow(label, { url })` 打开。
  - `label`：`session-${sessionId}`；若已存在同名窗口则 `setFocus()` 而不是重复创建。
  - `url`：`index.html?session=<id>&project=<pid>&path=<encoded>&title=<encoded>`。
- 启动引导：`App.tsx` 挂载后读 `window.location.search`；等 `projectsReady` 后调用 `openSearchSession({ projectId, sessionId, title, sessionPath })`。
- **Tauri capability**：`src-tauri/capabilities/default.json`
  - `windows` 增加新窗口 label 模式（`"session-*"`）。
  - `permissions` 增加 `core:webview:allow-create-webview-window`（以及新窗口自用的 `core:default` 已在列表）。
- 新窗口是独立 React 实例，状态互不共享（符合「Pi JSONL 唯一事实来源」）。

## 数据流

```
SessionHeaderMenu (DropdownMenu)
  ├─ 复制 ID/路径 ──> clipboard + toast
  ├─ 查找 ──> ChatPage.findOpen=true ──> ChatFindBar ──> matches(messages)
  │                                            └─ jump ──> viewport.scrollToMessageIndex
  ├─ 重命名 ──> Dialog ──> onRenameSession ──> App ──> workspace.updateSession ──> session_update_ui_state
  └─ 新窗口 ──> lib/window.ts ──> WebviewWindow(url)
                                     └─ 新实例 App boot ──> openSearchSession(target)
```

## 权衡

- **查找只覆盖已加载消息**：不做全库/全 JSONL 搜索，避免引入后端搜索通道与索引复杂度；UI 文案不暗示全量搜索。若后续需要全量搜索，可扩展为 `sessions.search` 类似的 command。
- **高亮只标当前命中**：跨消息的富文本高亮需要改 Markdown 渲染管线，成本高、收益低，先用行级 ring 定位。
- **新窗口不做状态同步**：两个窗口各自持有一份前端状态，但都以 Pi JSONL 为事实来源，刷新即可一致。
- **capability 用 `session-*` 模式而非 `*`**：避免把所有权限授予任意窗口。

## 兼容 / 回滚

- 新增 props 全部可选，未传时菜单项隐藏，旧调用点行为不变。
- capability 与 boot 逻辑独立于其它功能，回滚只需还原这两个文件 + 移除菜单项。
