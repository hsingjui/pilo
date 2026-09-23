# 会话头部功能菜单

## Goal

在会话界面右上角（终端 / 临时会话按钮旁）新增一个菜单按钮，把「会话信息、会话内查找、重命名、新窗口打开」等零散/缺失的操作收拢到一个菜单里，减少对侧栏和其它面板的依赖。

## Requirements

1. **菜单入口**：在 `SessionHeader` 右侧按钮组（`TerminalSquare`、`MessageSquareDashed`、`PanelRight` 之后）新增一个图标按钮，点击展开下拉菜单。仅在非临时会话（`session && !session.temporary`）时出现。
2. **会话 ID**：菜单中展示当前会话 ID，点击复制到剪贴板，并给出复制成功反馈。
3. **会话文件路径**：菜单中展示会话文件路径 `session.sessionPath`，点击复制。无路径（草稿/未落盘会话）时该项禁用。
4. **在当前会话中查找**：在**当前会话已加载的对话消息**内按关键字查找；提供输入框、匹配计数、上一个/下一个（Enter / Shift+Enter），命中项滚动到可见位置。
5. **重命名会话**：菜单触发重命名（输入框 + 确认），复用侧栏重命名同一条数据通路。草稿会话禁用。
6. **在新窗口打开会话**：把当前会话在独立的新窗口打开，新窗口直接定位到该会话。

## Constraints

- 不复制 Pi 能力，菜单只做桌面端编排，不改变 Pi RPC 行为。
- 会话 ID 是「Pi JSONL 唯一事实来源」的标识；本地索引（SQLite）只是缓存，重命名沿用现有 `session_update_ui_state` 的 `titleOverride`，不写回 JSONL。
- 新增图标使用 `lucide-react`；图标按钮必须有 `aria-label`；使用 `src/ui` 现有的 `DropdownMenu` / `Dialog` / `Button` / `Tooltip` 原语。
- 用户可见文案为简体中文，`zh-CN.ts` 与 `en-US.ts` 同步新增 key，代码标识符与注释保持英文。
- 「查找」范围限定为当前会话内存中已加载的消息；受限点需在 UI 上不误导用户（不做「全库全文搜索」的暗示）。

## Acceptance Criteria

- [x] `SessionHeader` 中在终端按钮旁出现菜单按钮，非临时会话可见，临时会话/落地页不可见。
- [x] 打开菜单可看到会话 ID 与文件路径，分别点击可复制并出现成功提示；无路径时路径项禁用。
- [x] 菜单中可触发「在当前会话中查找」；输入关键字后显示匹配数，Enter/下一个可逐条跳转并滚动到命中消息。
- [x] 菜单中可触发「重命名会话」，确认后标题更新，侧栏与头部标题同步。
- [ ] 菜单中可「在新窗口打开会话」，新窗口启动后直接显示该会话。
- [ ] `pnpm format` / `pnpm check` / `pnpm build` 通过；`cargo fmt --all --check` / `cargo check` / `cargo clippy --all-targets --all-features -- -D warnings` 通过。
- [ ] Windows 侧 `pnpm tauri dev` 手动验证：菜单交互、查找跳转、新窗口定位会话。

## Notes

- 新窗口涉及 Tauri capability 变更，只能在 Windows 侧用 `pnpm tauri dev` 验证；WSL 侧仅做静态检查。
