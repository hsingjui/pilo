# Chat Runtime

## 目标

Pilo Chat 必须通过 Pilo Runtime 与 Pi RPC 通信，并对 React 暴露稳定、最小的聊天语义事件，而不是 Pi 的完整原始事件模型。

## Runtime 启动与发送

当用户在本地 Chat 中提交非空文本时，Pilo 必须确保当前 Local Connection 的 Pi RPC 进程处于可用状态；若尚未启动，则使用当前工作区启动 `pi --mode rpc`。随后发送 Pi RPC `prompt` 命令，消息内容与用户提交文本一致。

当当前 Pi RPC 已经处于运行状态时，后续消息必须复用该进程和 Pi session，而不是为每轮对话重新 spawn。

Scenario: 首轮真实发送
- GIVEN 当前 Chat 使用 Local Connection 且 Pi 尚未启动
- WHEN 用户提交一条非空消息
- THEN Runtime 启动真实 Pi RPC 并发送 `prompt`
- AND Chat 中保留该用户消息
- AND 不生成 mock assistant 回复

Scenario: 连续多轮
- GIVEN 当前 Pi RPC 已运行且上一轮已经结束
- WHEN 用户再次提交消息
- THEN Runtime 复用同一 Pi RPC/session 发送新的 `prompt`
- AND Chat 可以收到并展示下一轮 assistant 回复

## Pi Event Adapter

Runtime 必须在 Pi JSONL 解码之后、Tauri event 发送之前执行 Pi 事件语义适配。适配器只覆盖当前 Chat 需要的事件；未知或尚未支持的 Pi event 必须安全忽略，不得导致 RPC reader 退出或 Chat 崩溃。

Pilo 暴露给 Chat 的语义至少包括：assistant 回复开始、assistant 文本增量、assistant 回复结束、以及运行时错误。事件必须继续携带 Pi process generation，以便前端忽略旧进程事件。

文本增量必须来自 Pi assistant message 的增量事件；适配器不得通过对完整消息文本反复 diff 来模拟 streaming。

Scenario: 文本流式适配
- GIVEN Pi 在当前 generation 中生成 assistant 文本
- WHEN Pi 发出 assistant message 的文本增量事件
- THEN Adapter 产生对应的 Pilo assistant text delta 事件
- AND delta 内容保持原始顺序
- AND React 不需要解析 Pi 原始 event payload

Scenario: 未知事件兼容
- GIVEN Pi 发出当前 Pilo 尚未映射的事件类型
- WHEN Adapter 处理该事件
- THEN 该事件被安全忽略或仅进入调试记录
- AND 后续已支持事件仍能正常处理

## Chat 状态

Chat 在提交用户消息后必须创建当前轮次的运行状态。assistant 回复开始后创建一条 streaming assistant message；每个文本 delta 追加到同一条消息。回复结束后该消息切换为完成状态，并恢复 Composer 的普通发送状态。

如果回复结束时没有任何 assistant 文本，Chat 仍必须结束 running 状态，不得永久卡在 streaming。

Scenario: 流式 UI
- GIVEN 用户已经提交一条消息
- WHEN Runtime 连续发送多个 assistant text delta
- THEN Chat 在同一 assistant 消息中按顺序追加文本
- AND Composer 在生成期间显示停止操作
- AND 回复结束后 assistant 消息不再标记为 streaming

## 停止生成

用户在当前回复生成期间触发停止时，Pilo 必须向 Pi RPC 发送 `abort` 命令。停止生成不得等同于终止 Pi 进程；Pi RPC 进程保持可用于后续消息。

Scenario: 停止当前回复
- GIVEN 当前 assistant 回复正在 streaming
- WHEN 用户点击停止
- THEN Runtime 向 Pi 发送 `abort`
- AND 当前 Chat 轮次最终退出 running 状态
- AND Pi process 不因该操作被主动停止
- AND 用户之后仍可继续发送下一条消息

## 错误处理

Pi 启动失败、RPC 写入失败、JSONL/RPC 解码失败或 Runtime process error 必须能反馈到 Chat。已经提交的用户消息不得因为失败被删除。错误展示可以是当前轮次 assistant 错误消息或等价的 Chat 内可见状态，但不得只记录在控制台。

Scenario: 运行时错误可见
- GIVEN 用户已经提交消息
- WHEN Pi 启动、RPC 发送或运行时处理失败
- THEN Chat 保留用户消息
- AND Chat 显示可理解的错误反馈
- AND Composer 最终恢复为可重试状态

## 工具调用活动展示

助手消息中的工具调用列表必须保持简洁：每个工具调用默认显示单行摘要（图标、工具名、关键参数预览）。工具调用运行中时保持可见的运行指示；一次回复完成后，所有已展开的工具调用详情自动收起，仅保留单行摘要，用户点击行可再次展开或收起。

展开后的详情必须是一个单一的轻量文本区块，按顺序展示参数与输出，不渲染「参数」「输出」独立标题面板。

Scenario: 完成后收起
- GIVEN 一次回复中发生了至少一次工具调用且详情处于展开状态
- WHEN 该回复结束（完成或停止）
- THEN 每个工具调用自动收起为单行摘要
- AND 摘要包含图标、工具名和关键参数预览

Scenario: 点击展开详情
- GIVEN 某个工具调用详情处于收起状态且存在参数或输出
- WHEN 用户点击该工具调用行
- THEN 详情在单一轻量区块中展示参数与输出
- AND 区块内不出现「参数」「输出」独立标题面板
- AND 再次点击后重新收起

## Connection 边界

Local Connection 只负责本地环境探测与 Pi process launch plan。Pi event 的语义解释属于共享 Runtime 层。未来 WSL/SSH Connection 接入时必须复用同一 Pi Event Adapter 与 Chat Runtime Event 模型，而不是复制事件映射。

## 非目标

本规格不要求实现 WSL/SSH transport、完整 Pi tool call UI、extension UI、Session 扫描/导入、SQLite conversation 存储或通用 Agent 协议。