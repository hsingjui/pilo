# 会话历史增量加载 · 技术设计

## 1. 现状管线

`load_history`（`reader.rs`）→ `read_file` 从 0 分块读 → `HistoryParser::push/finish`
→ `parse_history_entries`：`active_branch_indices` → `collect_history_stats`（全文件记录 + 分支 `context_tokens`）
→ `project_branch`（顺序状态机，`TurnMeta`）→ `serialize_windowed_history`：`split_history_messages` → `describe_history_message` → 逐消息序列化，记录 `message_ranges`、`message_index_json`、`image_locations`
→ 按估算大小写入内存 LRU 或 `DiskHistory`。

## 2. 检查点

`project_branch` 在处理 **user 消息** 或 **`compaction`** 时先 `finish_turn(false)` 关闭上一轮，`TurnMeta` 归零；
`split_history_messages` 中 `UserMessageStart` / `CompactionMarker` 都单独成一条消息，且前一条消息已被 `AssistantTurnEnd` 收尾。
因此这两类分支记录前后是投影和切分的干净边界，称为检查点：

- 检查点之前的消息字节永不受后续追加影响（前提：检查点仍在新分支上）。
- 检查点及之后的分支记录用「检查点处保存的状态」为初值重新投影；末尾一轮的 `AssistantTurnEnd(Interrupted)` 必在检查点之后，每次重算。

**只保留 1 个检查点**：当前分支上最后一个 user/compaction 记录。Pilo 的分叉走 Pi `fork`/`clone` 生成新文件，同文件切分支少见，不值得多读一轮；切回检查点之前一律退回全量。

**判定条件**：从新叶子沿 `parentId` 在尾部记录中回溯，必须走到检查点的 `entry_id`。该条件同时覆盖「检查点之后切换分支」。走出尾部仍未遇到检查点、遇到循环或尾部无带 id 记录 → 退回全量。

前提（写入 spec）：同一会话文件内记录 id 唯一（Pi `generateId` 带查重）。尾部 id 若与前缀记录重复，全量 `by_id` 会指向更晚记录，增量无法检测。

## 3. 状态结构

```rust
// cache.rs，挂在 SessionHistoryWindowIndex 上，内存与磁盘缓存共用
pub(super) struct IncrementalState {
    committed_offset: u64,       // 最后一个以 '\n' 结尾的完整行之后
    verify_start: u64,           // min(checkpoint.file_offset, committed_offset - 4 KiB)，不小于 0
    verify_digest: [u8; 32],     // sha256(源[verify_start..committed_offset])
    checkpoint: Option<Checkpoint>, // None：分支上无 user/compaction，从文件头重投影
    header_missing: bool,        // 只由文件首条记录决定，前缀校验通过即不变
    incremental_updates: u32,
}

pub(super) struct Checkpoint {
    entry_id: String,
    file_offset: u64,            // 检查点行起始偏移（BOM 前）
    message_index: usize,        // 检查点对应切分消息序号 k
    // 检查点之前（不含）的状态
    model: Option<SessionHistoryModel>,
    thinking_level: Option<String>,
    name: Option<String>,
    source_message_count: usize,
    stats_before: SessionHistoryStats,     // 文件偏移 < file_offset 的全部记录（不限分支）；context_tokens 字段不用
    context_tokens_before: Option<u64>,    // current_branch_context_tokens(分支[..检查点])
}

// SessionHistoryWindowIndex 新增
directory_ranges: Vec<Range<usize>>,       // message_index_json 中每条目录的字节范围
incremental: Option<Arc<IncrementalState>>,
```

`events_cut = message_ranges[k].start`，`directory_cut = directory_ranges[k].start`，由索引现算，不另存。
`estimated_index_bytes` 计入 `directory_ranges` 与增量状态。

## 4. 统一投影入口

全量解析 = 以「文件开头、空状态」为检查点的增量投影，两条路径共用代码，避免分叉：

```rust
struct ProjectionBase {
    read_offset: u64,            // 解析器基准偏移
    message_index: usize,
    model, thinking_level, name, source_message_count,
    stats_before: SessionHistoryStats,
    context_tokens_before: Option<u64>,
    image_locations: HashMap<String, ImageLocation>, // 前缀已有位置
    anchor_id: Option<String>,   // 回溯终点；None 表示走到根
    header_missing: Option<bool>,// 前缀已确定的值；None 表示从尾部（含文件头）判断
}

struct TailProjection {
    messages: Vec<Vec<ConversationEventDto>>, // 已切分，序号从 base.message_index 起
    model, thinking_level, name, source_message_count, header_missing,
    stats: SessionHistoryStats,
    image_locations: HashMap<String, ImageLocation>,
    committed_offset: u64,
    next_checkpoint: Option<Checkpoint>,
}
```

- `parser.rs`：`HistoryParser` 增加基准偏移，`entries` 存 `(line_offset, Value)`；`finish` 产出尾部记录、`committed_offset`（最后一个 `\n` 之后）。
- 分支：在尾部记录内建 `by_id`，从最后一个带 id 的记录回溯到 `anchor_id`；`anchor_id = None` 时与现有 `active_branch_indices` 完全一致（含无 id 头部插入规则）。
- `parser_stats.rs`：`stats = stats_before + 尾部全部记录`；`context_tokens` 先在尾部分支上按现规则找（尾部有 compaction 时只看最后一个之后），找不到且尾部无 compaction 时用 `context_tokens_before`。
- `parser_projection.rs`：`project_branch` 接受初值，遇到 user/compaction 记录时先快照「处理前」状态，最后一个快照成为 `next_checkpoint`；快照的 `stats_before` = `base.stats_before + 尾部中偏移更小的全部记录`，`context_tokens_before` = 分支前缀候选值，`message_index` 在切分后回填（按 `source_entry_id` 匹配该检查点产生的首条消息）。
- `serialize.rs`：`describe_history_message` 使用全局序号 `base.message_index + i`，保证 `history-{role}-{index}` 后备 id 一致；记录 `directory_ranges`。

## 5. 增量流程（`reader.rs::load_history`）

1. 取 key 的 `load_lock`；确定真实指纹（客户端指纹未命中时先探测源文件指纹再查缓存，延续当前修复）；命中直接返回。
2. 未命中：克隆旧缓存（任意指纹）的存储与索引 `Arc`，**不淘汰**。
3. 尝试增量的前提：有 `IncrementalState`；`incremental_updates < 64`；真实 `file_size >= committed_offset`。
4. 获取 `acquire_cold_load()` 许可（同样受全局 2 槽限制，控制并发峰值）。
5. 从 `verify_start` 起分块读到首块快照大小，复用现有快照 / `HISTORY_CHANGED_DURING_READ` 重试逻辑：
   - 对 `[verify_start, committed_offset)` 计算 sha256，不符 → 退回全量；
   - 从 `checkpoint.file_offset`（无检查点则 0，即全量）起的字节送入解析器。
6. 构造 `ProjectionBase`（来自检查点与旧索引的图片位置表），投影尾部；回溯未到达检查点 → 退回全量。
7. 拼接：
   - 事件：`old[..events_content_start]` 原样 + `old[events_content_start..events_cut]`（去掉末尾逗号的处理与现序列化一致）+ 新消息 + 新尾段（`model`…`stats`）。
   - 目录：`old_dir[..directory_cut]` + 新目录条目 + `]`。
   - `message_ranges`/`directory_ranges`：旧前缀范围保留，新范围按偏移追加。
   - 图片位置：旧表克隆 + 尾部新位置覆盖。
8. 写回：新指纹、新 `IncrementalState`（`incremental_updates + 1`，冷读重置为 0），按现有内存/磁盘预算规则插入，替换旧条目。
9. 第 3、5、6 步任何退回 → 走全量冷读，不提前淘汰旧投影；冷读同样产出 `IncrementalState`。
   增量过程的 I/O 错误记 `debug` 后退回全量。冷读失败、被取消或新投影不能入缓存时，旧指纹仍可命中旧投影；只有新投影成功入缓存时才替换旧条目。

## 6. 存储

- 内存：新建 `Vec`，拷贝前缀后追加；旧 `Arc` 继续服务在途请求。内存条目受 64 MiB 估算预算限制，拷贝为毫秒级。
- 磁盘：`DiskHistory::create_from_prefix(old: &DiskHistory, prefix: Range<usize>, tail: &[u8])`，在阻塞任务中将旧文件前缀流式拷入新的匿名缓存文件（同样随机名、0600/unlink、Windows delete-on-close），再写尾部。O(n) 本地 IO，无网络、无解析。
- 新大小超出内存预算时按现有规则改用磁盘；磁盘写失败时返回未缓存投影，与现行为一致。
- 增量或退回全量期间允许旧、新投影短暂同时驻留；新投影成功入缓存后才释放旧条目的缓存所有权。

## 7. 退回全量矩阵

| 条件 | 行为 |
| --- | --- |
| 无增量状态（首次加载、旧条目） | 全量 |
| 文件缩小（包括仅截断未提交的末行） | 全量 |
| 校验摘要不符（迁移重写、尾部被改） | 全量 |
| 回溯未经过检查点（切回更早分支） | 全量 |
| 尾部无带 id 记录、回溯循环 | 全量 |
| `incremental_updates >= 64` | 全量，计数清零 |
| 大小不变仅 mtime 变化 | 全量；尾部摘要无法排除前缀被等长改写 |
| 末行写到一半 | 增量；该行按全量规则解析但不计入 `committed_offset`，下次重读 |
| 读取中文件增长 | 现有快照与重试语义 |
| 增量失败或被取消 | 旧缓存保留 |

## 8. 兼容与风险

- 对外格式、前端、pilo-server 不变；旧远端 pilo-server 已支持偏移读取。
- 只在文件增长时尝试增量；假设 Pi 正常追加不会改写检查点之前的字节。如果增长的同时改写了前缀，尾部校验无法检测；每 64 次增量强制全量以限制影响。
- id 唯一是前提；违反时显示可能与全量不同，直到下次全量。
- 回滚：去掉增量分支即恢复全量冷读；缓存不持久化，无数据迁移。

## 9. 实现偏差（2026-11-18）

- 校验区间改为 `[checkpoint.file_offset, committed_offset)`，不再往前多读 4 KiB。`sha2 0.10` 不能导出哈希状态，但 `Sha256` 可 `Clone`：解析器从偏移 0 起对完整行持续哈希，检查点保存行首处的哈希状态，投影保存提交点的摘要；续读时接着该状态哈希，到旧提交点比对摘要。额外 4 KiB 只能覆盖极少数改写，不值得为它保存逐行状态。
- 无检查点时不产出增量状态（等价于从 0 全量读）。检查点必须是以换行结尾的完整行，避免末行仍在增长。
- 检查点的 `message_index` 由序列化器按 `source_entry_id` 匹配该检查点产生的首条消息回填。
- 拼接逻辑在 `incremental.rs::extend_projection`（同步、无网络，测试直接调用）；`reader.rs` 只负责续读、退回和入缓存。缓存插入改为先判断能否放下再移除旧条目。
