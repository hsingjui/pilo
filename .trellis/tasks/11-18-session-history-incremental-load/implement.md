# 会话历史增量加载 · 执行计划

## 前置

- 依赖当前工作区未提交的会话历史 / 事件内存优化批次（含 `reader.rs` 客户端指纹探测修复、`evict_stale_memory` 调整、spec 更新）。该批次提交后再开工，避免与其改动交叉。
- 开工前加载 `trellis-before-dev`，阅读 `.trellis/spec/backend/history-cache.md`。

## 步骤

0. **修复原生 Windows 测试启动**（`src-tauri/build.rs`，可能新增清单文件）
   - 按 `research/windows-test-0xc0000139.md` 先确认根因，再做最小修复。
   - 验证：原生 Windows 运行 `cargo test -p pilo --lib session_history`（TMP/TEMP/TMPDIR 指向 `target/review-tests/rust-tmp`），用例能启动执行；对比修复前后应用二进制的嵌入清单一致。
   - 根因不符时停下，回到规划阶段。
   - 可单独提交。

1. **索引扩展**（`cache.rs`、`serialize.rs`）
   - `SessionHistoryWindowIndex` 增加 `directory_ranges`、`incremental`；`estimated_index_bytes` 计入。
   - 序列化目录时记录每条范围；`describe_history_message` 接受全局序号基准。
   - 检查：`cargo check -p pilo`。
2. **解析器基准偏移**（`parser.rs`）
   - `HistoryParser` 支持起始偏移，记录行偏移与 `committed_offset`；全量路径以 0 调用，行为不变。
3. **统一投影入口**（`parser.rs`、`parser_projection.rs`、`parser_stats.rs`）
   - 引入 `ProjectionBase` / `TailProjection`；以锚点回溯分支；`project_branch` 接受初值并记录检查点快照；统计支持基准与 `context_tokens` 前缀候选。
   - 全量冷读改走「空基准」入口，并产出 `IncrementalState`。
   - 评审点：全量路径产物与改动前逐字节一致；先在改动前为几份代表性会话记录全量输出作为基线，改动后运行现有用例与基线对比。
4. **序列化拼接**（`serialize.rs`）
   - 由旧前缀字节 + 新消息 + 新尾段生成内存产物与新索引。
5. **磁盘前缀拷贝**（`disk.rs`）
   - `DiskHistory::create_from_prefix`，沿用随机名、权限、delete-on-close。
6. **增量读取与调度**（`reader.rs`）
   - `read_file_once` 支持起点与校验区间（sha256）；`load_history` 加入增量分支、退回矩阵、计数上限 64；增量和全量回退都只在新投影成功入缓存后替换旧条目。
   - 增量路径加 `debug` 日志：起点偏移、读取字节、是否退回及原因（不记录路径与内容）。
7. **Spec**
   - 更新 `.trellis/spec/backend/history-cache.md`：增量契约、检查点定义、退回矩阵、id 唯一前提、计数上限。
8. **静态校验**
   - `cargo fmt --all --check`
   - `cargo check`（需要拉依赖时设 `HTTP(S)_PROXY=http://127.0.0.1:7890`）
   - `cargo clippy --all-targets --all-features -- -D warnings`
9. **等价性测试**（`session_history/tests.rs`）
   - 辅助函数：对同一字节内容分别走「全量投影」与「先投影前缀、再增量投影追加部分」，断言序列化字节、`message_ranges`、`directory_ranges`、目录 JSON、图片位置、统计完全相同。
   - 场景：普通追加、多轮追加、末行写到一半后补齐、检查点之后切分支、尾部含 compaction / 图片 / model / thinking / session_info、仅 mtime 变化。
   - 退回场景：截断、整文件重写（摘要不符）、切回检查点之前、无带 id 记录、计数上限；断言退回后结果等于全量，且失败路径不淘汰旧缓存。
   - 运行：原生 Windows `cargo test -p pilo --lib session_history`，日志写入 `target/review-tests/unit.log`。
10. **手动验证**
    - SSH 连接打开大会话连续对话，开启 debug 日志确认每轮增量起点与读取字节；重启 Pilo 后全量加载，界面历史一致。

## 回滚点

- 步骤 1–3 完成后全量路径应与原行为一致，可单独提交。
- 步骤 4–6 是增量能力本身；回滚时移除 `load_history` 增量分支即恢复全量冷读，缓存不持久化，无迁移。
