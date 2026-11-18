# 会话历史增量加载

## Goal

会话 JSONL 追加内容后，Host 只读取并重投影「检查点之后的尾部」，不再整文件重读、全量解析和序列化。SSH 连接每轮传输量从整个会话文件降到最近一轮加新增内容；结果与全量解析逐字节一致，不能确认安全时退回现有全量冷读。

## 背景与已确认事实

- 每轮结束 Host 广播 `session_turn_completed`；桌面端 `chat-page.tsx` 调 `reconcileHistory()`，WebUI `use-remote-chat-transport.ts` 也处理该事件，触发历史读取。
- 新一轮让文件指纹（`fileSize` + `fileMtimeNs`）必然变化；缓存只按精确指纹命中，未命中即 `read_file` 从偏移 0 全量读取（16 MiB 分块经 `session.read`），全量解析、序列化，大文件再写磁盘缓存。成本 O(文件大小)/轮，整个会话生命周期近似平方增长。
- Pi 1.5.2（`dist/core/session-manager.js`）对已有会话文件的写入：
  - 常规写入 `_appendEntry → _persist → appendFileSync`，每条一行，只追加；`loadEntriesFromFile` 补换行也是追加。
  - 唯一改写已有文件内容的路径：打开 `version < 3` 的旧会话时 `migrateToCurrentVersion` 后 `_rewriteFile()`，以 `"w"` 截断后整体重写，非原子。
  - 空文件写头、首次落盘（`"wx"`）、`createBranchedSession` / fork 都写新路径或从 0 字节开始。
  - Pilo 不写 Pi 会话文件。
- 语义不是只追加：`branch()` / `resetLeaf()` 只移动内存叶子，下一条记录的 `parentId` 可指回更早节点。Pilo `active_branch_indices` 以文件最后一条带 id 的记录为叶子沿 `parentId` 回溯，追加一行就可能换掉整条显示路径；`compaction` 影响后续 `context_tokens`。
- Pilo 的「从某条消息分叉」走 Pi `fork` / `clone`（`src/lib/chat/pi-session-fork.ts`），产生新会话文件，不在原文件内切换分支；同文件内切分支主要来自 Pi TUI `/tree` 或扩展，属于少见路径。
- pilo-server `session.read` 已支持任意 `offset`/`limit`，每块返回 `fileSize`、`fileMtimeNs`、`nextOffset`、`eof`；不需要改 pilo-server，远端旧版本兼容。
- `src-tauri` 已依赖 `sha2`。
- CI 只跑 `cargo fmt`/`check`/`clippy`，不跑 `cargo test`；原生 Windows 上 `cargo test -p pilo --lib` 启动即 0xc0000139 退出（与代码无关）。

## Requirements

1. 缓存的历史投影（内存或磁盘）附带增量状态；源文件指纹变化时，在满足条件的情况下只读取校验区间与检查点之后的尾部并重投影。
2. 增量产物与对同一文件做全量解析的产物逐字节一致：序列化历史、`message_ranges`、消息目录 JSON、图片位置表、统计（含 `context_tokens`）、`model`/`thinkingLevel`/`name`/`headerMissing`/`sourceMessageCount`。
3. 以下情况必须退回现有全量冷读：无增量状态、文件变小、校验区间摘要不符、新分支未经过检查点、尾部无可用记录或出现循环、连续增量达到上限。
4. 增量尝试失败、被取消或退回全量之前，不得提前淘汰仍有效的旧缓存。
5. 增量只使用 `session.read` 返回的真实指纹；客户端传入的指纹只用于命中判断。
6. Host 对外接口、IPC/HTTP 响应格式、前端、pilo-server 均不改。
7. 读取中文件继续增长时沿用现有快照与 `HISTORY_CHANGED_DURING_READ` 重试语义。
8. 更新 `.trellis/spec/backend/history-cache.md`，写明增量契约、退回条件与 Pi id 唯一前提。
9. 在 `session_history/tests.rs` 增加增量与全量的等价性测试，覆盖验收标准列出的全部场景和退回场景。
10. 排查并修复原生 Windows 上 `cargo test -p pilo --lib` 以 0xc0000139 退出的问题，使测试可在原生 Windows 运行（不经 WSL）；修复不得改变正式应用的嵌入清单与运行行为。研究记录见 `research/windows-test-0xc0000139.md`。

## Acceptance Criteria

- [ ] 普通追加一轮后再次读取历史：只发起从校验区间起点到文件末尾的 `session.read`，不再从偏移 0 读取。
- [ ] 第 2 条列出的全部产物与全量解析逐字节一致，覆盖：普通追加、多轮追加、写到一半的末行、检查点之后切分支、尾部含 compaction、尾部含图片、尾部含 model/thinking/session_info 变更、文件大小不变仅 mtime 变化。
- [ ] 文件截断、旧版本迁移重写、切回检查点之前的分支、增量次数到上限时退回全量，结果与全量一致。
- [ ] 增量读取失败或调用方取消后，旧缓存仍可命中原指纹。
- [ ] 原生 Windows 上 `cargo test -p pilo --lib` 能正常启动并运行；新增等价性测试与 `session_history` 现有测试全部通过（临时目录重定向到 `target/review-tests/`）。
- [ ] 修复测试启动问题后，正式应用的嵌入清单与修复前一致。
- [ ] `cargo fmt --all --check`、`cargo check`、`cargo clippy --all-targets --all-features -- -D warnings` 通过。
- [ ] 手动验证：SSH 连接打开大会话连续对话，日志显示每轮读取字节数随单轮大小而非会话总大小变化，界面历史与重启后全量加载一致。

## Out of Scope

- 磁盘缓存改为只追加分段存储、去掉每轮前缀拷贝（后续优化）。
- 切回检查点之前分支时的多区间增量读取。
- 前端历史加载、`reconcileHistory` 触发时机的调整。
- Pilo 解析器处理 `context_edit`（当前忽略，本任务保持不变）。
- pilo-server 侧摘要计算或新 RPC。

## Decisions

- 检查点只保留 1 个（Pilo 分叉生成新文件，同文件切分支少见）。
- 测试方案选 A：新增等价性测试，并把 0xc0000139 排查修复纳入本任务。
- 开工顺序：当前未提交的会话历史 / 事件内存优化批次提交后再开始。

## Open Questions

- 无。若 0xc0000139 根因不是 Windows 清单，回到规划阶段重新评估。
