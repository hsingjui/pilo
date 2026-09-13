# Pilo Conversation Pipeline 统一设计

> 状态：Proposed
> 日期：2026-09-12
> 范围：Chat / Session history / Thinking / Tool Call 的统一消息状态机
> 不包含：Pi process、RPC transport、Connection、generation 等 Runtime 基础设施的整体重构

## 1. 背景

Pilo 当前有两条会话内容处理链路：

```text
新开 / 继续对话
Pi RPC
  ↓
PiloRuntimeEvent
  ↓
ChatPage 内的一组 start / append / finish callbacks
  ↓
ChatMessage[]
  ↓
React UI
```

以及：

```text
已有 Session
Pi JSONL
  ↓
session.read
  ↓
SessionHistory.messages
  ↓
chat-history.ts
  ↓
ChatMessage[]
  ↓
React UI
```

两条链路最终都生成 `ChatMessage[]`，但生成过程不同。

这已经产生了实际问题：

- 历史 Session 最初只恢复 assistant text，thinking / tool call 丢失。
- 补齐 thinking / tool 后，历史 assistant JSONL 记录一度被错误拆成多个 UI Assistant 消息。
- toolCall / toolResult 的配对、thinking 与 text 的顺序、footer 时机需要在历史路径重复实现。
- 实时路径修复一个顺序问题时，历史路径不会自动获得同样的修复。
- `ChatPage` 同时承担 Runtime 事件处理、消息状态机、历史加载、滚动、模型、thinking、queue 和 UI，职责过重。

因此需要统一的是 **Conversation 状态机**，而不是把整个 Pilo Runtime 推倒重写。

---

## 2. 已确认的 Session 原则

本设计继续遵守 Pilo 已有原则：

1. **Pi JSONL 是 Session conversation 的唯一事实来源。**
2. **SQLite 只保存可重建的 Session 索引和 Pilo UI 状态。**
3. **不把完整 conversation 作为 authoritative SQLite 数据保存。**
4. **点击旧 Session 只读取 Session 文件，不启动 Pi。**
5. **只有向旧 Session 真正发送消息时才启动 / 恢复 Pi。**
6. **旧 Session 查看阶段修改模型或 thinking 只改变前端待选配置，不修改 Session。**
7. Local / WSL / SSH 使用同一套 Session history 与 Conversation 语义。

旧 Session 的目标加载路径保持为：

```text
点击 Session
  ↓
session_history
  ↓
pilo-server session.read
  ↓
读取 Pi JSONL
  ↓
恢复 Conversation
  ↓
渲染

Pi process: 不启动
```

只有发送时：

```text
用户发送
  ↓
client.ensure()
  ↓
pi --mode rpc --session <sessionPath>
  ↓
应用当前选择的 model / thinking（如需要）
  ↓
prompt
```

---

## 3. 目标

### 3.1 核心目标

历史和实时最终必须通过 **同一个 Conversation Reducer** 生成消息状态：

```text
                  Pi 实时事件
                      │
                      ↓
              Runtime Conversation Adapter
                      │
                      │ ConversationAction
                      ↓
                 Conversation Reducer
                      │
                      ↓
                   ChatMessage[]
                      │
                      ↓
                    React UI
                      ↑
                      │
                 History Replay
                      ↑
                      │ ConversationEvent[]
                      │
                Session History Adapter
                      ↑
                      │ active branch entries
                Session Branch Resolver
                      ↑
                      │
                  Pi Session JSONL
```

### 3.2 一致性目标

以下行为只允许存在一套状态机实现：

- User / Assistant 的 turn 分组。
- 一个 turn 中多个 Pi assistant message 合并成一个 UI Assistant message。
- thinking / text / tool 的真实顺序。
- toolCall 与 toolResult 的关联。
- 并行工具调用。
- tool running / complete / error 状态。
- assistant completion。
- stopReason / errorMessage。
- work duration。
- steer / follow-up 导致的新 user turn。
- 未知历史内容的可见 fallback。

### 3.3 性能目标

- Session JSONL 的读取与 JSON 解析主要在 Rust / pilo-server 路径完成。
- 前端不再承担原始 JSONL 的复杂归一化。
- 前端历史 replay 使用纯 reducer，并支持分批执行，避免大型 Session 长时间阻塞 WebView 主线程。
- 不因为浏览历史 Session 创建 Pi process。

---

## 4. 非目标

这次不整体重构以下内容：

```text
ServerManager
ServerPiSession
ChatSessions registry
Pi process spawn / stop / restart
RPC request / response
JSONL RPC framing
Local / WSL / SSH transport
generation 生命周期
queue transport
model RPC
thinking level RPC
session watcher
parallel agent runtime
```

这些模块如果未来出现独立的结构问题，再单独设计 Runtime 重构。

本次只重构：

> **会话内容事件如何变成 ChatMessage。**

---

## 5. 为什么不直接让后端返回 ChatMessage

不建议 Rust 直接构造前端 `ChatMessage`。

`ChatMessage` 包含明显的 UI 语义，例如：

- `streaming`
- `replyRunwayPx`
- 前端 content id
- queued UI 状态
- React 展示所需的局部状态

如果 Rust 直接输出最终 UI model，会造成 Backend 与 React 展示模型耦合。

更合理的边界：

```text
后端负责：
- 读取 JSONL
- 理解 Pi Session 持久化格式
- 根据 `id / parentId` 解析 Session tree，并只选择当前 active branch
- 清理持久化兼容细节
- 转换为中立 ConversationEvent

前端负责：
- Conversation Reducer
- ChatMessage
- optimistic / pending UI
- 展开折叠
- Markdown
- tool detail
- virtualization
- copy / footer / interaction
```

即：

> 后端决定「发生了什么」，前端决定「状态如何展示」。

---

## 6. Event 与 Runtime 的边界

### 6.1 不直接把全部 PiloRuntimeEvent 作为 ConversationEvent

当前 `PiloRuntimeEvent` 既有会话内容，也有 Runtime 控制事件。

Conversation 相关：

```text
user_message_start
assistant_message_start
assistant_text_delta
assistant_text_snapshot
assistant_thinking_start
assistant_thinking_delta
assistant_thinking_end
tool_execution_start
tool_execution_update
tool_execution_end
assistant_message_end
```

Runtime Control 相关：

```text
process_state
rpc_message
queue_update
runtime_log
runtime_error
```

本次只统一第一组。

### 6.2 推荐的前端类型关系

概念上：

```ts
type PiloRuntimeEvent = RuntimeConversationEvent | RuntimeControlEvent;
```

但第一阶段不要求立刻修改 Rust `RuntimeEvent` enum 的整体结构。

前端可以先提供一个轻量 adapter：

```ts
function toConversationAction(
	event: PiloRuntimeEvent,
): ConversationAction | null;
```

这样不会为了 Conversation 重构把整个 Runtime 一起改掉。

---

## 7. ConversationEvent 设计

History Adapter 返回的中立事件应尽量与实时事件的语义一致，而不是返回已经分组好的 UI turn。

建议的持久化/回放事件必须保留稳定来源身份。History event 不能只带文本，因为稳定 id 还要用于 history reload、增量刷新、React key 和 branch reconcile：

```ts
type ConversationEventMeta = {
	timestampMs?: number;
	sourceEntryId?: string;
	sourceContentIndex?: number;
};

type ConversationEvent = ConversationEventMeta &
	(
		| {
				type: "user_message_start";
				text: string;
				timestampMs?: number;
		  }
		| {
				type: "assistant_message_start";
				timestampMs?: number;
		  }
		| {
				type: "assistant_text_delta";
				delta: string;
				timestampMs?: number;
		  }
		| {
				type: "assistant_text_snapshot";
				text: string;
				timestampMs?: number;
		  }
		| {
				type: "assistant_thinking_start";
				timestampMs?: number;
		  }
		| {
				type: "assistant_thinking_delta";
				delta: string;
				timestampMs?: number;
		  }
		| {
				type: "assistant_thinking_end";
				timestampMs?: number;
		  }
		| {
				type: "tool_execution_start";
				toolCallId: string;
				toolName: string;
				args: unknown;
				timestampMs?: number;
		  }
		| {
				type: "tool_execution_update";
				toolCallId: string;
				toolName: string;
				args: unknown;
				partialResult: unknown;
				timestampMs?: number;
		  }
		| {
				type: "tool_execution_end";
				toolCallId: string;
				toolName: string;
				result: unknown;
				isError: boolean;
				timestampMs?: number;
		  }
		| {
				type: "assistant_turn_end";
				stopReason?: string | null;
				errorMessage?: string | null;
				completion?: "complete" | "interrupted";
		  }
	);
```

### 7.1 为什么保留 delta 语义

历史记录中的完整 text / thinking 可以作为一个大的 delta replay：

```text
历史 thinking block
→ thinking_start
→ thinking_delta(full text)
→ thinking_end
```

历史 text block：

```text
text block
→ assistant_text_delta(full text)
```

Reducer 不需要知道事件来自实时流还是历史 replay，也不关心 delta 是 1 个 token 还是完整一段文本。

---

## 8. ConversationAction 与本地 UI Action

只靠持久化 `ConversationEvent` 还不够，因为实时 UI 有 optimistic 状态。

例如用户按下发送后，页面必须立即显示：

- User message。
- Assistant「启动中...」。

不能等 Pi 真正发回 `user_message_start` / `assistant_message_start`。

因此 reducer 输入建议使用更完整的 `ConversationAction`：

```ts
type ConversationAction =
	| ConversationEvent
	| {
			type: "local_user_submit";
			text: string;
			timestampMs: number;
			replyRunwayPx?: number;
	  }
	| {
			type: "local_user_queue";
			clientMessageId: string;
			text: string;
			queueKind: "steer" | "follow_up";
			timestampMs: number;
	  }
	| {
			type: "local_user_queue_failed";
			clientMessageId: string;
	  }
	| {
			type: "local_assistant_pending";
			timestampMs: number;
			replyRunwayPx?: number;
	  }
	| {
			type: "local_turn_abort";
			timestampMs: number;
	  }
	| {
			type: "conversation_runtime_error";
			message: string;
			timestampMs: number;
	  };
```

这类 local action 不需要后端理解，也不会出现在历史 Session 中。

### 8.1 首条 user_message_start 的去重

本地 optimistic user 必须生成稳定的 `clientMessageId`。Pi runtime 当前没有对应 correlation id，因此 acknowledgement 使用 **pending queue 的顺序** 确认，不允许仅用 `text` 作为 identity；相同文本的连续 steer / follow-up 必须可以独立成功或失败。

实时发送时：

```text
local_user_submit
→ UI 立即插入 user

Pi user_message_start
→ reducer 识别这是当前 pending user 的 runtime acknowledgement
→ 不重复插入
```

### 8.2 steer / follow-up

运行中：

```text
local_user_queue
→ UI 显示 queued user

Pi user_message_start
→ 结束当前 Assistant UI turn
→ 找到对应 queued user，移除 queued 标记
→ 在该 user 后创建下一段 Assistant
```

这就是当前 `beginQueuedMessage()` 行为，但以后由 reducer 统一负责。

历史 replay 遇到 user message 时也走相同的 turn boundary 规则。

---

## 9. ConversationState / Reducer

建议新增纯状态模型：

```ts
type ConversationState = {
	messages: ChatMessage[];
	active: {
		userMessageId?: string;
		assistantMessageId?: string;
		userStarted: boolean;
		turnStartedAtMs?: number;
		assistantUpdatedAtMs?: number;
	} | null;
};
```

Reducer：

```ts
function reduceConversation(
	state: ConversationState,
	action: ConversationAction,
	context: ConversationReducerContext,
): ConversationState;
```

Context 负责纯逻辑不能自己获取的依赖：

```ts
type ConversationReducerContext = {
	createMessageId: (kind: "user" | "assistant") => string;
	createContentId: (kind: "text" | "thinking") => string;
	now: () => number;
	formatTime: (timestampMs: number) => string;
};
```

测试中可以传 deterministic id / time factory。

### 9.1 Reducer 的职责

Reducer 负责：

- 插入 user message。
- 创建 / 复用当前 Assistant UI message。
- append / reconcile assistant text。
- start / append / finish thinking。
- start / update / finish tool。
- 通过 `toolCallId` 更新原位置，不改变内容顺序。
- 正常完成 turn 时把 running activity 收束为 complete；历史 EOF 推断为 interrupted 时必须保留 turn-level interrupted/error 可见状态，不能伪装成正常完成。
- 写入 stopReason / errorMessage。
- 计算 workDurationMs。
- 处理 queued user acknowledgement。

Reducer **不负责**：

- 启动 Pi。
- 发送 RPC。
- generation filter。
- model / thinking RPC。
- toast。
- desktop notification。
- scroll。
- Session 文件读取。

这些副作用仍由 controller / ChatPage 外层负责。

---

## 10. History Adapter 设计

History Adapter 前必须先解析 Pi Session tree。Pi JSONL 是 append-only 文件，但当前 conversation 并不是“所有物理行”的线性拼接：发生 tree branch 后，旧分支仍留在 JSONL 中。History 必须先根据 entry `id / parentId` 从最新 leaf 回溯到 root，得到当前 active branch；model / thinking / session metadata 也必须从该 branch 推导。

```text
Pi JSONL
  ↓
SessionEntry[]
  ↓
Active Branch Resolver
  ↓
active branch entries
  ↓
ConversationEventDto[]
```

建议将历史格式解析从 `src/lib/chat-history.ts` 下沉到 Rust 的独立模块，而不是继续堆在 `session_index.rs`。

建议新增：

```text
src-tauri/src/runtime/session_history.rs
```

职责：

```text
Pi JSONL bytes
  ↓
逐行 serde_json parse
  ↓
识别 Pi Session entry
  ↓
ConversationEventDto[]
```

`session_index.rs` 继续只负责：

- Session metadata index。
- stale 判断。
- reconcile。
- append-only index 增量解析。

`session_history.rs` 专门负责 conversation history。

### 10.1 JSONL → Event 映射

#### User message

```text
message(role=user)
→ user_message_start
```

#### Assistant thinking

```text
assistant content: thinking
→ assistant_thinking_start
→ assistant_thinking_delta(full thinking)
→ assistant_thinking_end
```

历史 thinking 中存在的 ANSI 控制字符和终端 `Thinking:` 前缀在 History Adapter 清理。

#### Assistant text

```text
assistant content: text
→ assistant_text_delta(full text)
```

#### Tool call

```text
assistant content: toolCall
→ tool_execution_start
```

#### Tool result

```text
toolResult
→ tool_execution_end
```

结果通过 `toolCallId` 关联原工具。

#### Orphan toolResult

如果旧版本 Session 中出现找不到对应 toolCall 的 result：

```text
synthetic tool_execution_start
→ tool_execution_end
```

保证内容可见，不静默丢失。

#### bashExecution compatibility

旧 Session 的 `bashExecution` 映射为 synthetic bash tool：

```text
tool_execution_start(name=bash)
→ tool_execution_end(result=output)
```

#### Unknown content

未知 assistant content / message role 不直接丢弃，但 extension state 不能无条件渲染。`custom` / label 等非 conversation entry 只作为 metadata；`custom_message` 仅在可显示时进入 conversation。image content 暂未支持时显示有限长度占位，不能把大型 base64 直接塞进 Markdown。

真正未知且可显示的 conversation content 转换为有限长度 fallback text event，例如 JSON code block，保证：

> Session 中可读取的内容不会因为 Pilo 暂不认识某个新 Pi 类型而静默消失。

---

## 11. 一个 User Turn 中多个 Assistant JSONL 记录

Pi 在一个 agent turn 内可能产生：

```text
user
assistant(thinking + toolCall)
toolResult
assistant(thinking + text + toolCall)
toolResult
assistant(text)
```

这里不能渲染成多个独立 Assistant UI message。

History Adapter 可以忠实发出多个 `assistant_message_start`，但 Reducer 的规则是：

```text
如果当前 user turn 已有 Assistant UI message：
assistant_message_start = ensure assistant exists
而不是创建第二条 UI Assistant message
```

只有出现新的 `user_message_start` 才真正切换 UI turn。

因此：

```text
1 个 user turn
+ N 个 Pi assistant message
+ N 个 toolResult

最终仍是：
1 个 User UI message
+ 1 个 Assistant UI message
```

Assistant 内部 content 顺序完整保留。

---

## 12. assistant_turn_end 的历史语义

Pi 实时链路中，单个 `message_end` 并不代表整个 agent turn 完成。

当前 `PiEventAdapter` 会在 `agent_settled` 时生成 Runtime 层的：

```text
assistant_message_end
```

`Runtime Conversation Adapter` 再将它映射为 Conversation 层的：

```text
assistant_turn_end
```

Session JSONL 没有完全等价的 `agent_settled` 记录，因此 History Adapter 需要推断 turn completion：

```text
当前 turn
  ↓
遇到下一条 user message
  ↓
发出 completion=complete 的 assistant_turn_end

EOF
  ↓
若最后 assistant 有 terminal stopReason → complete
否则（例如 toolUse 后直接 EOF）→ interrupted
```

使用该 turn 最后的：

- timestamp。
- stopReason。
- errorMessage。

作为 completion metadata。

这样历史和实时对「整轮回复结束」的定义保持一致。

---

## 13. 时间与 work duration

时间也必须进入统一状态机，而不是历史和实时各自计算。

### 实时

实时区分 UI submit 和 agent turn start。`submittedAtMs` 用于 pending UX；历史 / 实时需要可比较的工作时长时，以 Pi acknowledgement / agent turn start 为准。

```text
local_user_submit.timestampMs
→ submittedAtMs

user_message_start.timestampMs / acknowledgement
→ turnStartedAtMs

assistant_turn_end.timestampMs / now()
→ finishedAtMs
```

### 历史

```text
user JSONL timestamp
→ turnStartedAtMs

turn 最后一个 assistant/tool result timestamp
→ assistant_turn_end.timestampMs
```

Reducer 统一计算：

```text
workDurationMs = finishedAtMs - turnStartedAtMs
```

UI 仍只负责如何显示，例如：

```text
工作了 12 秒
工作了 2 分 8 秒
```

---

## 14. History API

当前：

```ts
SessionHistory {
  messages: unknown[];
  model;
  thinkingLevel;
  name;
}
```

目标：

```ts
SessionHistory {
  events: ConversationEvent[];
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  name: string | null;
  sourceMessageCount: number;
}
```

`sourceMessageCount` 表示当前 active branch 中的原始 Session message 数，不使用 event 数作为 Session message count。物理 JSONL 中废弃 branch 的 message 不进入当前 conversation count。

Tauri command 仍然是：

```text
session_history(projectId, sessionPath)
```

它仍然只调用：

```text
pilo-server session.read
```

**禁止调用 `chat_session_start`、`pi.start` 或 `client.ensure()`。**

---

## 15. 实时链路迁移

当前 `ChatPage` 中下列函数本质上就是一套隐式 reducer：

```text
startAssistantMessage
appendAssistantDelta
reconcileAssistantText
startAssistantThinking
appendAssistantThinkingDelta
finishAssistantThinking
startToolExecution
updateToolExecution
finishToolExecution
finishAssistantMessage
beginQueuedMessage
```

这些函数的纯状态更新逻辑迁入：

```text
src/lib/conversation-reducer.ts
```

实时 ChatPage 最终变成：

```ts
const action = toConversationAction(runtimeEvent);
if (action) {
	dispatchConversation(action);
}
```

ChatPage 只保留必要副作用：

- generation filter。
- runtime failure 判断。
- `readCurrentPiSessionState()`。
- notification。
- scroll。
- queue count。

---

## 16. 历史链路迁移

目标：删除 `chat-history.ts` 中独立构造 `ChatMessage` 的复杂逻辑。

最终：

```text
loadSessionHistory()
  ↓
SessionHistory.events
  ↓
replayConversationEvents()
  ↓
Conversation Reducer
  ↓
ConversationState.messages
```

历史与实时不再分别维护：

- thinking mapping。
- tool merging。
- turn grouping。
- work duration。
- completion。

---

## 17. 大 Session 与前端卡顿

即使 JSONL 解析下沉 Rust，大 Session 的 event replay 仍可能产生大量前端 reducer 操作。batch yield 只能降低连续主线程占用，不能掩盖 O(N²) reducer；Reducer 内应保留 active assistant / toolCall lookup 等索引能力，并允许未来增加 batch builder，在一个 batch 内只 publish 一次 immutable state。

常规 Session 可以同步 replay，但建议从一开始提供 batch helper：

```ts
async function replayConversationEventsBatched(
	events: ConversationEvent[],
	options: {
		maxEventsPerBatch: number;
		onBatch: (state: ConversationState) => void;
	},
): Promise<ConversationState>;
```

例如：

```text
处理 300~500 events
→ publish state
→ yield 1 frame
→ 下一批
```

重点：

- **先按同一个 reducer 完成事件关系处理，再控制 React publish 频率。**
- 不按原始 JSONL 100 条直接独立归一化，否则 toolCall / toolResult 可能跨 batch。

后续如果出现几十 MB / 上万消息 Session，再增加：

- cursor。
- 向上滚动加载更早 turn。
- 增量 history cache。

第一阶段不需要提前实现完整分页系统。

---

## 18. ConversationState ownership

每个 Pilo Session 拥有一份独立 `ConversationState`。Chat controller/store 以 `sessionId -> ConversationState` 缓存；历史 replay、optimistic action 和 runtime event 都修改同一份 state，切换 Session 不重新拼接 `historyMessages + localMessages` 两套数组。

---

## 19. 旧 Session 从历史切到实时

这是本设计必须保证的关键场景。

### 打开旧 Session

```text
History Adapter
→ reducer replay
→ state.messages

Pi: 未启动
```

### 用户在旧 Session 发送新消息

不重建一套新的 message state。

直接在当前 reducer state 上：

```text
历史 state.messages
  ↓
local_user_submit
  ↓
local_assistant_pending
  ↓
client.ensure()
  ↓
Pi Runtime events
  ↓
同一个 reducer
```

因此历史和实时之间没有 UI 数据模型切换。

旧 Session 恢复 Pi 后只负责未来新增事件，不重新通过 Pi 获取整个历史。

---

## 20. Session 外部修改的一致性

Pi CLI 或其他 Pi 实例可能修改同一个 Session JSONL。

原则仍然是：

```text
JSONL = truth
memory state = cache
```

Session watcher 检测 `fileSize / mtimeNs` 变化后，应将已加载 history 标记为 stale。

推荐行为：

- 只是浏览：下次激活时重新读取 / 增量更新 history。
- 第一次继续旧 Session 前，如果已知 history stale，先刷新 history，再启动 Pi。

这样保证：

```text
页面看到的 Session
≈ Pi --session 实际加载的 Session
```

这一项可以作为统一 reducer 完成后的第二阶段优化，不阻塞第一阶段落地。

---

## 21. 推荐文件边界

目标结构：

```text
src/
  lib/
    conversation-types.ts
      ChatMessage
      ConversationEvent
      ConversationAction
      ConversationState

    conversation-reducer.ts
      reduceConversation
      replayConversationEvents
      replayConversationEventsBatched

    conversation-runtime-adapter.ts
      PiloRuntimeEvent -> ConversationAction

    sessions.ts
      SessionHistory DTO / Tauri invoke

  components/chat/
    chat-page.tsx
      orchestration + side effects + render

src-tauri/src/runtime/
  session_index.rs
    session metadata/index only

  session_history.rs
    JSONL -> ConversationEventDto[]

  commands.rs
    session_history command wiring only
```

`src/lib/chat-history.ts` 在迁移完成后删除，或只留下极薄的兼容 wrapper，最终不再包含独立消息状态机。

---

## 22. 分阶段实施计划

### Phase 0 — 固化现有行为测试

在重构前补齐 reducer 需要覆盖的行为测试：

- thinking → text → tool → thinking → text 顺序。
- 并行 tool call。
- tool result 更新原 tool 位置。
- assistant 多段 message 仍属于同一 user turn。
- steer / follow-up user boundary。
- aborted / error。
- unknown fallback。

目的：重构过程中只改变结构，不改变 UI 语义。

### Phase 1 — 抽 Conversation 类型与纯 Reducer

新增：

```text
conversation-types.ts
conversation-reducer.ts
```

将 `ChatPage` 现有消息更新 callback 的纯逻辑迁入 reducer。

这一阶段历史路径可以暂时保持旧实现。

验收：

- 新开会话实时渲染完全不变。
- 当前 Pi Runtime / generation / transport 不变。

### Phase 2 — 实时 ChatPage 接入 Reducer

`PiloRuntimeEvent` 通过 adapter 转换成 `ConversationAction`。

移除 ChatPage 中重复的 message mutation callback。

ChatPage 保留副作用 orchestration。

验收：

- 实时 text / thinking / tool / parallel tool 与当前 UI 一致。
- steer / follow-up 一致。
- abort / runtime error 一致。

### Phase 3 — Rust History Adapter

新增 `session_history.rs`：

```text
JSONL -> ConversationEventDto[]
```

`SessionHistory.messages` 改为 `SessionHistory.events`。

验收：

- 点击旧 Session 仍不启动 Pi。
- Pi JSONL 中所有已知内容都能转成 event。
- 未知内容有 fallback。

### Phase 4 — History Replay 接入同一 Reducer

删除 `mapPiHistoryMessages()` 的独立状态机。

历史使用：

```text
SessionHistory.events
→ replayConversationEvents
```

验收：

- 历史与实时同一 fixture 最终 `ChatMessage` 深度等价（忽略随机 id）。
- 一个 user turn 只产生一个 Assistant UI message。

### Phase 5 — 大 Session replay 优化

加入 batch replay / publish。

记录：

- read duration。
- event normalize duration。
- reducer replay duration。
- first visible content duration。

只有真实数据证明需要时再实现 cursor / history pagination。

### Phase 6 — Cleanup

删除：

- 旧 `chat-history.ts` 复杂 mapper。
- ChatPage 中已迁移的 mutation callbacks。
- 不再使用的兼容字段。

不在这一阶段扩张到整个 Runtime 重构。

---

## 23. 建议的提交拆分

为了便于 review / rollback，建议至少拆成：

```text
1. test: lock conversation rendering semantics
2. refactor: add shared conversation reducer
3. refactor: route live chat through conversation reducer
4. refactor: emit conversation events from session history
5. refactor: replay history through shared reducer
6. perf: batch large history replay
7. cleanup: remove legacy history mapper
```

不要把所有步骤压成一个巨型 commit。

---

## 24. 测试策略

### 23.1 Reducer 单测

纯 TypeScript 测试，不需要 Tauri / Pi：

```text
ConversationAction[]
→ reducer
→ ChatMessage[]
```

重点测试：

- text streaming。
- snapshot reconcile。
- thinking start/delta/end。
- tool start/update/end。
- parallel tools。
- tool error。
- multi-assistant same turn。
- multiple user turns。
- queued steer / follow-up。
- completion / error / aborted。
- deterministic workDuration。

### 23.2 History Adapter Rust 单测

```text
JSONL fixture
→ ConversationEventDto[]
```

覆盖：

- 常规 message。
- thinking ANSI。
- toolCall/toolResult。
- orphan result。
- bashExecution compatibility。
- model/thinking/session_info metadata。
- unknown entry。

### 23.3 历史 / 实时等价测试

最重要的测试：

准备同一语义的两组输入：

```text
A: 实时 PiloRuntimeEvent sequence
B: Session JSONL
```

分别经过：

```text
A -> runtime adapter -> reducer
B -> history adapter -> reducer
```

最终比较：

```text
ChatMessage[]
```

忽略：

- 随机 id。
- 实时与历史不可避免的 wall clock 微小差异。

必须一致：

- role。
- text。
- content type/order。
- thinking text/status。
- tool name/args/result/error/status。
- turn grouping。
- stop reason。

### 23.4 集成验证

真实 Session 至少覆盖：

- Local。
- WSL。
- SSH（条件允许时）。
- 大量 tool call Session。
- thinking 较多 Session。
- 外部 CLI 创建的 Session。

---

## 25. 性能验收

第一阶段不设过度严格的绝对毫秒指标，但必须记录关键阶段。

建议埋点：

```text
session_history.read_ms
session_history.normalize_ms
conversation_replay.ms
conversation_replay.event_count
conversation_replay.message_count
history.first_render_ms
```

期望：

- 常规 Session 点击后不等待 Pi process 初始化。
- 几百条 JSONL 的 Session 不出现明显主线程冻结。
- 大 Session replay 能通过 batch yield 保持交互响应。

---

## 26. 风险与处理

### 风险 1：RuntimeEvent 与 ConversationEvent schema 漂移

处理：

- runtime adapter 单独集中维护。
- 建立 schema/fixture 测试。
- History Adapter 不直接生成 ChatMessage。

### 风险 2：实时 optimistic user 与 Pi user event 重复

处理：

- reducer 明确 pending user acknowledgement 规则。
- 不依赖组件层临时去重。

### 风险 3：一个 Pi turn 有多个 assistant message

处理：

- `assistant_message_start` 是 ensure，不是无条件 append。
- user event 才是 UI turn 的主要边界。

### 风险 4：toolResult 跨 JSONL / batch

处理：

- History Adapter 先形成完整事件关系。
- Reducer 通过 `toolCallId` 更新。
- React publish batch 不作为语义 batch。

### 风险 5：大型 Session event replay 仍卡主线程

处理：

- Rust 做 JSON parse / normalization。
- reducer replay 分批 yield。
- 后续再按真实数据决定 pagination。

### 风险 6：重构范围扩张到 Runtime

处理：

- 明确非目标。
- 不修改 process / transport / generation 的架构。
- Runtime 全面重构单独立项。

---

## 27. 验收标准

统一 Conversation Pipeline 完成后必须满足：

- [ ] 新对话实时消息通过 `ConversationReducer` 生成 `ChatMessage[]`。
- [ ] 旧 Session 历史通过同一个 `ConversationReducer` 生成 `ChatMessage[]`。
- [ ] 历史 Session 点击加载不启动 Pi。
- [ ] 旧 Session 只有发送消息时才 `client.ensure()` / `pi.start`。
- [ ] 查看旧 Session 时修改 model / thinking 不修改 Session。
- [ ] text / thinking / tool 的顺序在历史和实时一致。
- [ ] 多个 Pi assistant message 在同一个 user turn 中只显示一个 Assistant UI message。
- [ ] 并行工具调用和 toolResult 配对一致。
- [ ] tool error / aborted / assistant error 行为一致。
- [ ] steer / follow-up turn boundary 与实时行为一致。
- [ ] 未知 Session content 不静默丢失。
- [ ] History Adapter 的 JSONL 解析不放在 React 主线程。
- [ ] 大 Session replay 不长时间阻塞 WebView 主线程。
- [ ] SQLite 仍不保存 authoritative full conversation。
- [ ] `pnpm check` 通过。
- [ ] `pnpm build` 通过。
- [ ] Rust `cargo fmt --all --check` / `cargo check` / clippy 通过。

---

## 28. 后续是否需要全面 Runtime 重构

完成本设计后再观察，而不是现在提前进行。

只有当出现多项以下信号时，再单独设计 Runtime v2：

- Local / WSL / SSH 出现大量分支和重复生命周期逻辑。
- Pi session 需要 suspend / resume / LRU / reconnect，并且当前 registry 难以维护。
- Parallel Agent 与普通 Chat 大量重复 runtime orchestration。
- generation / reconnect 竞态频繁发生。
- 一个功能必须同时侵入 `server_pi.rs`、`chat_sessions.rs`、`commands.rs` 和多个前端层。
- Runtime 测试越来越依赖完整 Pi process，纯逻辑难以独立测试。

目前优先级：

```text
P0: Conversation 状态机统一       → 现在做
P1: ChatPage controller/hooks 拆分 → 紧随其后评估
P2: 整个 Runtime 重构            → 暂不需要
```

---

## 29. 最终设计结论

采用：

```text
Session JSONL
   ↓
Active Branch Resolver
   ↓
Rust History Adapter
   ↓
ConversationEvent[] ───────────────┐
                                  │
Pi RPC                            │
   ↓                              │
PiloRuntimeEvent                  │
   ↓                              │
Runtime Conversation Adapter      │
   ↓                              │
ConversationAction ───────────────┤
                                  ↓
                         Conversation Reducer
                                  ↓
                              ChatMessage[]
                                  ↓
                               React UI
```

核心约束：

> **Session 是数据，Pi 是执行器，Conversation Reducer 是唯一的前端消息状态机。**

这能解决历史与实时渲染长期漂移的问题，同时不需要为了这次改动重写整个 Runtime。
