# nsh 迁移 M0：风险验证

父任务：`11-19-nsh-desktop-migration`。本任务先于其他里程碑，结论决定迁移是否继续。

## Goal

用最小的代码量验证四项可能使迁移不成立的风险，每项给出“通过 / 有条件通过 / 不通过”的结论和证据。

## 背景与已确认事实

- Chat 原型已在 macOS 原生和浏览器验证通过（父任务 `research/nsh-feasibility.md`），但使用模拟数据、模拟按键，且未在 Windows 运行。
- 现有运行时基于 Tokio，46 个文件引用 `tauri::`；nsh 文档称 `background(…)` 中可使用 Tokio，未实测。
- Windows 是 Pilo 的首要发布目标。当前调研机器是 macOS，Windows 项需要一台 Windows 机器。

## Requirements

1. **Rust 运行时接入**：在 `desktop/native` 中导出 Rust 模块，调用现有运行时的真实代码（不复制逻辑），在 nsh 窗口里显示真实项目的会话列表，并把一次真实 `pi --mode rpc` 对话的流式事件渲染出来。记录事件从 Rust 到界面的延迟和高频增量下的帧率。
2. **Windows**：在 Windows 10/11 上运行 Chat 原型；验证原生窗口渲染、微软拼音输入、`nsh package` 生成的安装器的安装、覆盖升级与卸载；托盘、全局快捷键、单实例各试一次。
3. **Composer 输入**：在 macOS 与 Windows 用真实输入法输入中文；实现 `@` 触发、跟随光标位置的候选弹层、插入提及；粘贴图片；拖入文件；Enter 发送与 Shift+Enter 换行。比较 `Input` 与 `RichEditor` 两种实现并选定一种。
4. **共享 TS 逻辑**：在 nsh 应用中直接导入 `src/lib/chat/conversation-reducer.ts` 及其依赖，用真实事件驱动出消息列表；确认 nsh 打包器对仓库内其他目录、`tsconfig` 路径别名和第三方纯 TS 依赖的支持情况。
5. 每项结论、数据、截图写入本任务 `research/`，并回写父任务 `design.md` 的“待 M0 验证”项。
6. 不修改 `src/`、`src-tauri/` 的现有行为；为接入而做的最小抽取要保持 Tauri 版可编译、可运行。

## Acceptance Criteria

- [ ] nsh 窗口显示来自现有数据目录的真实会话列表，数据经由 Rust 模块而非 HTTP。
- [ ] 一次真实 Pi 对话的流式输出在 nsh 窗口完整渲染，有延迟与帧率记录。
- [ ] Windows 上的原生窗口截图、输入法录屏或截图、安装器安装/升级/卸载结果。
- [ ] `@` 提及、粘贴图片、拖入文件在 macOS 与 Windows 各有通过或不通过的明确结论，并写明选用 `Input` 还是 `RichEditor`。
- [ ] `conversation-reducer` 在 nsh 中直接复用成功，或给出不能复用的原因和替代方案的工作量。
- [ ] 四项各有结论；给出继续 / 中止建议。
- [ ] `nsh check`、`nsh test` 通过；`cargo check` 通过；Tauri 版 `pnpm build` 与 `cargo check` 不受影响。

## Out of Scope

- 完整的运行时抽离（属于 M1）。
- 任何可交付给用户的界面。
- Linux 验证。

## Open Questions

- Windows 验证使用哪台机器（需要用户提供或授权一台 Windows 环境）。
