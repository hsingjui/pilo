# Session Header Menu — 执行计划

## 顺序 Checklist

### A. i18n（先行，避免后续引用缺失）

- [x] `src/i18n/resources/zh-CN.ts` + `en-US.ts` 新增 key：
  - `chat.sessionMenu`（菜单 aria-label）
  - `chat.sessionId` / `chat.sessionFilePath` / `chat.findInSession` / `chat.renameSession` / `chat.openInNewWindow`
  - `chat.copySessionId` / `chat.copySessionFilePath`（或复用 `chat.copied`）
  - `chat.find.*`（placeholder、上一个、下一个、匹配计数、无结果、关闭）
  - `chat.renameDialogTitle` / `chat.renameDialogConfirm`

### B. 会话头部菜单（ID / 路径 / 动作入口）

- [x] 新建 `src/components/chat/chat-session-header-menu.tsx`
  - `SessionHeaderMenu({ session, onRenameSession, onFindInSession, onOpenInNewWindow })`
  - `DropdownMenu`：Trigger 图标按钮（`lucide-react` 的 `MoreHorizontal`，`aria-label=t("chat.sessionMenu")`，`size-7`，与相邻按钮一致）
  - 内容：ID 行（点击复制）、路径行（无路径禁用）、分隔、查找 / 重命名 / 新窗口（handler 未传则不渲染）
  - 内嵌重命名 `Dialog`（`Input` + 确认/取消）
- [x] `src/components/chat/chat-session-header.tsx`
  - 新增可选 props `onRenameSession` / `onFindInSession` / `onOpenInNewWindow`
  - 在按钮组末尾渲染 `<SessionHeaderMenu>`（仅 `session && !session.temporary`）

### C. 重命名数据通路

- [x] `ChatPageProps` 增加 `onRenameSession?: (title: string) => void`，透传到 `SessionHeader`
- [x] `src/App.tsx`：给 `ChatPage` 传 `onRenameSession={(title) => void updateSession(entry.session.id, { title })}`

### D. 会话内查找

- [x] `src/lib/conversation-outline.ts`：导出可复用的 `messageSearchText(message)`（纯文本化）
- [x] 新建 `src/components/chat/use-chat-message-search.ts`：由 `messages` + `query` 计算 `matches: {messageIndex, start, snippet}[]`
- [x] 新建 `src/components/chat/chat-find-bar.tsx`：输入框、匹配计数、上一个/下一个、关闭；Enter/Shift+Enter；Esc 关闭
- [x] `use-chat-scroll-controller.ts`：抽出 `jumpToMessageIndex(messageIndex)`，其内复用现有 pending-jump + drift 修正逻辑；在返回值中导出
- [x] `chat-conversation-viewport.tsx`：
  - handle 增加 `scrollToMessageIndex(index)`
  - 新增 props `highlightMessageId?` / 传给 `MessageRow` 的 `highlighted`
  - `renderMessage` 传入 `highlighted={message.id === highlightMessageId}`
- [x] `MessageRow`：`highlighted` 时在内容外包一层 `relative` div + 绝对定位 ring 叠层（不占布局）
- [x] `chat-page.tsx`：持有 `findOpen`/`findQuery`/`activeMatchIndex`；`useKeyboardShortcut("mod+f", ..., { enabled: active })` 打开；渲染 `ChatFindBar`；把 `onFindInSession` 传给 `SessionHeader`

### E. 新窗口打开会话

- [x] 新建 `src/lib/window.ts`：`openSessionInNewWindow(target)`，`WebviewWindow` + 已存在则 `setFocus`
- [x] `src-tauri/capabilities/default.json`：`windows` 增 `"session-*"`；`permissions` 增 `"core:webview:allow-create-webview-window"`
- [x] `App.tsx`：boot 读取 `location.search`，`projectsReady` 后调用 `openSearchSession(target)`
- [x] `ChatPageProps` 增 `onOpenInNewWindow?: () => void`，透传；`App.tsx` 传入（用 `session.projectRecord.id` / `session.id` / `session.sessionPath` / title）

## 验证命令

```bash
pnpm format
pnpm check
pnpm build
```

Rust（capability 改动后）：

```bash
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

Windows 侧手动验证（必须）：

```bash
pnpm tauri dev
```

- 菜单按钮出现在终端按钮旁；ID/路径复制成功
- 查找：输入、计数、Enter 跳转并定位到命中消息
- 重命名：头部与侧栏标题同步
- 新窗口：新窗口打开后直接显示该会话

## 回滚点

- 阶段 B/C/D 纯前端，回滚删除新增文件 + 还原 `chat-session-header.tsx` / `chat-page.tsx` / 相关 lib。
- 阶段 E 额外涉及 `capabilities/default.json` 与 boot 逻辑，单独回滚。

## Review Gates

- B 完成后：`pnpm check` + 目视菜单结构。
- D 完成后：查找跳转交互自测。
- E 完成后：Windows `pnpm tauri dev` 验证。
- 全部完成后：`pnpm build` + Rust 三项检查，再更新 spec / 提交。

## 实际执行结果（收尾记录）

- 全部前端步骤已实现，`pnpm format` / `pnpm check` / `pnpm build` / `pnpm test:unit`（134 通过）全绿。
- 与原计划的偏差：
  - 查找逻辑落在纯函数 `src/lib/chat-message-search.ts`（`findMessageMatches`），未建 `use-chat-message-search.ts` hook；查找条组件 `src/components/chat/chat-find-bar.tsx` 内部持有 `query` / `activeIndex`，`chat-page.tsx` 只持有 `findOpen` 与高亮消息 id。
  - `MessageRow` 的高亮用外层 `div`（`bg-primary/5 ring-1 ring-primary/30`）承载，未用绝对定位 ring 叠层；ring 为 box-shadow，不影响虚拟列表测量。
  - 跳转经由 `ChatFindLayer` 的 `onNavigate(messageIndex)` 回调（`chat-page.tsx` 的 `handleFindNavigate`），未把 viewport ref 传进查找条 —— 读取 `ref.current` 放进 effect 依赖会触发 `exhaustive-deps` lint。
  - 新增 `tests/chat-message-search.test.ts` 并登记进 `package.json` 的 `test:unit`，按 frontend quality spec 要求（`src/lib/` 纯逻辑需配套测试）。
  - `App.tsx` 重命名用 `entry.piSessionId ?? entry.session.id`，与侧栏数据通路对齐。
- 未执行：Rust 三项检查（本次未改 Rust 源码，仅改 `capabilities/default.json`）；Windows 侧 `pnpm tauri dev` 手动验证（需在 Windows 执行）。

## 后续追加（用户追加要求）

- 会话内查找改为**字符级**：`findMessageMatches` 每条命中位置各出一条记录（新增 `occurrenceIndex`），查找文本改用原始 `message.text`（含 Markdown / 代码块），assistant 回复也可搜；新增 `src/lib/dom-text-highlight.ts`（CSS Custom Highlight API）做命中字符高亮，移除原先的整条消息级高亮（`highlightMessageId` / `highlighted`）。
- 会话窗口（新窗口）改为窄屏形态：`src/lib/window.ts` 默认 480×900 + `center`（min 360×420）；`App.tsx` 新增 `sessionWindow` 判定（由 `readSessionWindowTarget()` 派生），隐藏 `AppSidebar`，并在根节点加 `data-session-window`；`src/index.css` 用 `--conversation-max-width` 变量把消息列/输入框宽度上限从 `min(80%,52rem)` 放开到 `min(94%,52rem)`。
- 测试：`tests/chat-message-search.test.ts` 随行为变更更新，并补充「代码块可搜」「同一消息多次命中各报一条」覆盖；`pnpm check` + `pnpm test:unit`（136 通过）+ `pnpm build` 全绿。
- 会话窗口新增「置顶」按钮：`src/components/title-bar.tsx` 的 `TitleBar` 增 `showAlwaysOnTop` prop + `AlwaysOnTopButton`（`getCurrentWindow().setAlwaysOnTop()` / `isAlwaysOnTop()`），仅在会话窗口显示；`src/App.tsx` 传 `showAlwaysOnTop={sessionWindow}`；`capabilities/default.json` 增 `core:window:allow-set-always-on-top` 与 `core:window:allow-is-always-on-top`；i18n 增 `app.pinWindow` / `app.unpinWindow`。
- 会话窗口判定从「URL 参数非空」改为「窗口 label 以 `session-` 开头」（新增 `isSessionWindow()`），不再依赖 URL query 是否保留；URL 参数只用于 boot 定位会话。
