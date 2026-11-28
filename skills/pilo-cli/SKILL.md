---
name: pilo-cli
description: 通过本机 `pilo` CLI 控制运行中的 Pilo 桌面应用：打开应用/项目/会话、管理 Pilo 项目（增删查）、编排与查询 Pilo 会话（列表/历史/状态/新建/发送/打断/停止/归档/恢复/更新/删除），以及读写 Pilo 偏好与主题。凡涉及用 `pilo` 命令操作 Pilo 客户端或其托管的 Pi 会话时触发；开发 Pilo 自身源码或操作非 Pilo 工具时不要触发。
---

# Pilo CLI

通过当前用户的本机私有 IPC（Unix socket / Windows named pipe）控制运行中的 Pilo 桌面端，无需 token、配对或开启 Remote WebUI。

- **适用范围**：仅限本机调用（远端 SSH/WSL 内无转发，但本机 CLI 可管理 Host 托管的 SSH/WSL 项目）。
- **启动行为**：普通命令在应用未运行时返回 `offline`（退出码 `3`），不擅自启动；需要自动拉起时用 `pilo open` 或追加 `--launch`。
- **全局选项**：`--dev`（连接开发版 `app.hsingjui.pilo.dev`，`pilo-dev` 默认即开发版）、`--launch`（离线时启动并执行一次）、`--timeout <秒>`（单次请求超时，默认 60）。
- **输入输出**：成功时 stdout 输出单个 JSON（退出码 `0`）；失败时 stderr 输出 `{"error":{"category","code","message"}}`（`help` 除外）。

## 命令速查

| 分类 | 命令                                                                                             | 说明                                                                      |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 基础 | `pilo version` / `pilo help`                                                                     | 查看版本与 `appId`（无需运行应用）/ 帮助文本                              |
| 窗口 | `pilo open`                                                                                      | 启动或唤起 Pilo 桌面窗口                                                  |
| 窗口 | `pilo open <dir>`                                                                                | 打开本地目录对应项目（未登记则自动添加）                                  |
| 窗口 | `pilo open --session <id>`                                                                       | 跳转到指定会话（支持完整 ID 或唯一前缀）                                  |
| 项目 | `pilo projects list`                                                                             | 列出全部项目及 `projectId`                                                |
| 项目 | `pilo projects add --path <path> [--connection <id>]`                                            | 添加项目，`--connection` 默认 `local`                                     |
| 项目 | `pilo projects remove <projectId>`                                                               | 移除项目                                                                  |
| 模型 | `pilo models list --project <id>`                                                                | 列出当前项目可用的 Pi 模型（`provider/id`）                               |
| 会话 | `pilo sessions list --project <id> [--offset N] [--limit N]`                                     | 分页列出会话（`limit` 1–100，默认 50；未落盘的临时会话在 `temporary` 中） |
| 会话 | `pilo sessions get <sessionId> --project <id>`                                                   | 查看会话详情                                                              |
| 会话 | `pilo sessions history <sessionId> --project <id> [--start N] [--limit N]`                       | 读取已保存消息（`limit` 1–100，默认 24）                                  |
| 会话 | `pilo sessions status <sessionId> --project <id>`                                                | 一次性查询状态快照，**永不启动 Pi**                                       |
| 会话 | `pilo sessions create --project <id> [--model <provider/id>] [--thinking <level>] [--temporary]` | stdin: `{"message":"...","title":"可选"}`，新建并发送首条消息             |
| 会话 | `pilo sessions send <sessionId> --project <id>`                                                  | stdin: `{"message":"..."}`，向已有会话发消息                              |
| 会话 | `pilo sessions abort <sessionId> --project <id>`                                                 | 仅打断当前生成轮                                                          |
| 会话 | `pilo sessions stop <sessionId> --project <id>`                                                  | 关闭 Pi 进程，保留历史                                                    |
| 会话 | `pilo sessions archive\|restore <sessionId> --project <id>`                                      | 归档隐藏 / 恢复显示                                                       |
| 会话 | `pilo sessions update <sessionId> --project <id>`                                                | stdin: `{"title":"可选","pinned":true}`，局部更新                         |
| 会话 | `pilo sessions delete <sessionId> --project <id>`                                                | 移入回收站（运行中会拒绝，需先 `stop`）                                   |
| 设置 | `pilo settings get` / `pilo settings patch`                                                      | 读取 / 字段级补丁更新偏好（stdin JSON）                                   |
| 设置 | `pilo settings theme get` / `pilo settings theme set`                                            | 读取 / 更新主题设置（stdin JSON）                                         |

> 会话命令的 `<sessionId>` 接受 Pi `sessionId`、`create` 返回的 `requestId` 或 `sessionKey`。

## 常用操作

### 1. 查找项目与会话，检查运行状态

```bash
pilo projects list
pilo sessions list --project <projectId> --limit 20
pilo sessions status <sessionId> --project <projectId>
```

`sessions status` 返回 `{sessionId, state, turn, runningTools, lastAssistantMessage}`：

- `state`：`idle` | `running` | `compacting` | `not_running` | `error`
- `runningTools`：当前运行中的工具名数组；无工具为 `[]`；快照截断或不可用时为 `null`（不猜测）。

### 2. 新建会话或继续发送消息

```bash
printf '{"message":"检查当前分支的测试是否通过","title":"跑测试"}' \
  | pilo sessions create --project <projectId>

printf '{"message":"把失败用例修一下"}' \
  | pilo sessions send <sessionId> --project <projectId>
```

- 消息必须为纯文本（≤ 64 KiB），不接受 `/slash` 命令。
- `create` 在 Pi 确认接收首条消息后立即返回，不等待生成完成；`--thinking` 可选 `off | minimal | low | medium | high | xhigh | max`；`--temporary` 仅驻留内存不落盘，仅在 Pi 运行时支持 `get / status / send / abort / stop`。
- 目标会话忙碌时 `send` 会直接拒绝（不静默排队）；可先查 `sessions status` 或 `sessions abort`。

### 3. 在桌面端打开项目或定位会话

```bash
pilo open .
pilo open --session <sessionIdOrUniquePrefix>
```

### 4. 整理会话与修改主题

```bash
printf '{"title":"重构完成","pinned":false}' \
  | pilo sessions update <sessionId> --project <projectId>

pilo sessions archive <sessionId> --project <projectId>
pilo settings theme get
```

## 退出码与异常处理

| 退出码 | category          | 处理建议                                                                                                        |
| ------ | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `0`    | —                 | 成功，解析 stdout 单个 JSON                                                                                     |
| `2`    | `invalid_input`   | 检查参数、必填字段或 stdin JSON 格式                                                                            |
| `3`    | `offline`         | 应用未运行，先执行 `pilo open` 或为命令加 `--launch`                                                            |
| `4`    | `incompatible`    | CLI 与应用协议主版本不匹配，在 Pilo「设置 → CLI」修复                                                           |
| `5`    | `rejected`        | 目标不存在、前缀有歧义、会话正忙或运行中不可删除                                                                |
| `6`    | `outcome_unknown` | 写入结果未知，**不要直接重试**；先用 `sessions status` / `sessions get` 查询（`create` 时查 `error.sessionId`） |
| `1`    | `internal`        | 内部错误，查看 stderr `error.message`                                                                           |
