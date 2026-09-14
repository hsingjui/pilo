# Pilo Roadmap

> Pi-native desktop project for local, WSL, and SSH development.

Last updated: 2026-09-11

## Status

- [x] Done
- [ ] Todo
- 🚧 In progress
- ⏸ Deferred

## Product Direction

Pilo 的目标是提供一个面向 Pi Coding Agent 的桌面开发工作区，在不复制 Pi runtime 能力的前提下，统一管理：

- Local / WSL / SSH 开发环境
- Project 与项目上下文
- Pi Session 与历史记录
- Chat / Thinking / Tool Call
- Git / Diff / Terminal / File Explorer
- 后续的并行 Agent、Worktree 和 Remote Preview

核心原则：

1. **Pi owns conversations.** Pi JSONL 是 Session 的唯一事实来源。
2. **Pilo owns presentation and indexes.** SQLite 只保存可重建的索引、缓存和桌面状态。
3. **Pi runs where the project lives.** Local、WSL、SSH 都在代码所在环境运行 Pi。
4. **Connection、Project、Session 分离。** 不把环境、目录和 Pi Session 混成一个概念。
5. **Remote first.** 新能力优先考虑是否适用于 Local / WSL / SSH。

---

## Current Progress

### Project Foundation

- [x] 初始化 Tauri 2 + React 19 + TypeScript + Vite 项目
- [x] 建立 WSL 开发、Windows 运行的开发模式
- [x] 添加 WSL → `D:\Code\pilo` 实时同步脚本
- [x] 初始化 Git 仓库
- [x] 使用 `oxfmt + oxlint` 替代 Biome
- [x] 配置 `pnpm format` / `pnpm check` / `pnpm build`

### Current Focus

🚧 **P3 Productization**

P0/P1 核心工作区与 P2 Remote/Parallel 基础能力已经落地，当前进入可靠性、设置与发布质量完善阶段。

---

# P0 — Usable Pi Desktop

目标：Pilo 可以真正作为 Pi 的日常桌面客户端使用。

## P0.1 UI Foundation

- [x] 拆分巨型组件文件：`app-sidebar.tsx` (857 行) → `src/components/sidebar/`，`App.tsx` (583 行) → `title-bar` / `sidebar-footer` / `new-chat-landing` / `right-sidebar`
- [x] 完成 Frontend Style Foundation
- [x] 建立应用主布局
- [x] 建立 Sidebar / Project / Session 基础组件
- [x] 建立 Chat Message / Thinking / Tool Call 基础视觉
- [x] 建立统一 Toast / Dialog / Dropdown / Tooltip 等基础交互
- [x] 建立基础空状态、加载状态和错误状态

## P0.2 Runtime Foundation

- [x] 建立 Tauri Command / Event 边界
- [x] 建立 `Connection` domain model
- [x] 建立可复用的 process execution abstraction
- [x] 建立 Pi process lifecycle manager
- [x] 建立 Pi RPC JSONL codec
- [x] 严格按 LF (`\n`) 拆分 RPC JSONL
- [x] stdout 仅处理 RPC，stderr 单独作为运行日志
- [x] 使用 generation id 忽略旧 Pi process 的 stale events
- [x] 支持 Pi process spawn / stop / restart / abort

实现约束：

- Local / WSL / SSH launcher 必须保留 Pi 正常的 user/global/project extensions 加载语义，生产启动参数不得使用 `--no-extensions`。

目标架构：

```text
React UI
    ↓
Tauri Commands / Events
    ↓
PiSession
    ↓
Pi RPC Codec
    ↓
PiTransport
    ├── Local
    ├── WSL
    └── SSH
```

## P0.3 Local Connection

- [x] Local Connection 数据模型
- [x] 检测本机 Pi 可执行文件
- [x] 检测 Pi 版本
- [x] 在指定 Project 启动 `pi --mode rpc`
- [x] 展示 cwd / Git branch / Pi version 等环境信息
- [x] 对启动失败、Pi 不存在、RPC crash 给出明确错误

## P0.4 Chat Runtime Integration

- [x] Local Chat 接入真实 `pi --mode rpc`
- [x] Pi 原始事件适配为稳定的 Pilo Runtime Event
- [x] `prompt` 与 assistant 文本流式输出
- [x] 同一 Pi process / session 连续多轮复用
- [x] `abort` 停止当前回复但保留 Pi process
- [x] Runtime / RPC 错误在 Chat 内可见，未知 Pi event 安全忽略

## P0.5 WSL Connection

- [x] WSL distro 枚举
- [x] WSL Connection 数据模型
- [x] 通过 `wsl.exe` 在目标 distro / cwd 启动 Pi RPC
- [x] RPC stdio 正确桥接到 Windows Tauri
- [x] 获取 WSL 内 Pi / Node / Git 环境信息
- [x] 支持 WSL Connection 重连
- [x] 验证当前主要开发环境 Debian

示意：

```text
Windows Tauri
    ↓ wsl.exe
WSL Debian
    ↓
pi --mode rpc
```

## P0.6 SSH Connection

- [x] SSH Connection 数据模型
- [x] 使用系统 OpenSSH `ssh`
- [x] 兼容 `~/.ssh/config` host alias
- [x] 兼容 SSH Agent / IdentityFile / ProxyJump / known_hosts
- [x] Pi RPC 使用 non-interactive、no-PTY 模式
- [x] 防止 banner / MOTD / shell stdout 污染 RPC JSONL
- [x] SSH 断线状态与重连
- [x] 基础连接测试和环境诊断

## P0.7 Project

- [x] Project 数据模型
- [x] Connection → Project 层级
- [x] Local Folder 添加 Project
- [x] WSL Project 添加 / 最近使用
- [x] SSH Project 添加 / 最近使用
- [x] Project metadata 本地缓存
- [x] Recent Projects
- [x] Discover existing Pi Projects

原则：

```text
Connection
    ↓
Project
    ↓
Session
    ↓
Pi RPC Process
```

## P0.8 Session Index

- [x] 引入本地 SQLite
- [x] `connections` 表
- [x] `projects` 表
- [x] `sessions` 派生索引表
- [x] Project 打开时先读 SQLite，立即展示缓存
- [x] 后台扫描 Pi Session JSONL metadata
- [x] 使用 `session_path + file_size + file_mtime_ns` 判断 stale
- [x] 新 Session 自动加入索引
- [x] 删除 Session 自动移除索引
- [x] changed Session 增量重新解析
- [x] 保存 `last_offset`，对 append-only JSONL 做增量解析
- [x] Project focus / reconnect 时 reconcile
- [x] 保留手动 Refresh Sessions

Pilo 本地数据统一存入 SQLite；其中 `sessions` 是可从 Pi JSONL 重建的派生索引，例如：

```text
connection_id
project_id
pi_session_id
session_path
name
cwd
created_at
updated_at
message_count
last_message_at
first_user_message_preview
file_size
file_mtime_ns
last_offset
indexed_at
```

不把完整 conversation 作为 authoritative SQLite 数据保存。

## P0.9 Session UI

- [x] Sidebar 默认展示当前 Project 全部 Pi Sessions
- [x] 按 Today / This Week / Older 分组
- [x] Session title / preview / updated time
- [x] Pin
- [x] Archive / Hide（Pilo UI 状态，不修改 conversation truth）
- [x] Session Search（metadata）
- [x] 新建 Session
- [x] Resume Session
- [x] Session rename
- [x] Session switch
- [x] Session list virtualization

## P0.10 Pi Chat

- [x] `prompt`
- [x] Streaming assistant output
- [x] Thinking 展示
- [x] Tool call / tool result 展示
- [x] `abort`
- [x] `follow_up`
- [x] `steer`
- [x] Model selector
- [x] Thinking level selector
- [x] Session name / state
- [x] Token / cost / context 基础状态
- [x] Markdown / code block 渲染
- [x] 大消息与 Tool Result 折叠
- [x] 长 Session 渲染 virtualization

## P0.11 Pi Extension UI Bridge ⏸ Deferred

- ⏸ `select`
- ⏸ `confirm`
- ⏸ `input`
- ⏸ `editor`
- ⏸ `notify`
- ⏸ `status`
- ⏸ `widget`
- ⏸ `title`

当前阶段暂不实现；后续恢复时目标仍是尽量不牺牲 Pi extension 生态兼容性。

## P0 Exit Criteria

- [ ] Local Pi 可以完成完整聊天流程
- [ ] WSL Pi 可以完成完整聊天流程
- [ ] SSH Pi 可以完成完整聊天流程
- [ ] CLI 新建/修改 Session 后 Pilo 能自动看到变化
- [ ] 退出 Pilo 后 Pi JSONL 不受破坏
- [ ] 清空 `sessions` 派生索引后可从 Pi JSONL 完整重建 Session 列表
- [ ] Windows 端可连续稳定使用作为日常 Pi Client

---

# P1 — Developer Project

目标：从“Pi Chat 客户端”升级为完整 Coding Project。

## P1.1 Git

- [x] Remote-aware `git status --porcelain`
- [x] Branch 信息
- [x] Changed files 列表
- [x] Working tree diff
- [x] Staged diff
- [x] Diff viewer
- [x] File ↔ Diff 快速跳转

## P1.2 Terminal

- [x] Terminal dock
- [x] Local shell
- [x] WSL shell
- [x] SSH shell
- [x] Terminal 与当前 Connection / Project 绑定
- [x] 多 Terminal tab
- [x] Terminal resize / persistence

## P1.3 Files

- [x] RemoteFs abstraction
- [x] `readDir`
- [x] `readFile`
- [x] `writeFile`
- [x] `stat`
- [x] `mkdir`
- [x] `rename`
- [x] `remove`
- [x] File Tree
- [x] 文件搜索

## P1.4 Editor

- [x] Monaco editor
- [x] 文件 tab
- [x] Dirty state
- [x] Save
- [x] Diff → Editor
- [x] Tool call 中的文件路径可直接打开

## P1 Exit Criteria

- [x] 不离开 Pilo 即可完成常规查看代码 / Git diff / Terminal 操作
- [ ] Local / WSL / SSH 三种环境的 Git / Terminal / File 基础能力行为一致

---

# P2 — Remote & Parallel Power

目标：把 Pilo 做成 Pi 的 remote-first 高级工作区。

## P2.1 Remote Helper

- [x] 定义 helper protocol
- [x] WSL helper deployment
- [x] SSH helper deployment
- [x] `session.scan`
- [x] `session.stat`
- [x] `session.watch`
- [x] `fs.*`
- [x] `git.*`
- [x] helper version negotiation / upgrade

## P2.2 Session Watcher

- [x] Local filesystem watcher
- [x] WSL inotify watcher
- [x] SSH remote watcher
- [x] watcher disconnect fallback 到 reconcile
- [x] reconnect 后 full metadata reconciliation

## P2.3 Worktree & Parallel Agents

- [x] Git worktree 管理
- [x] 一个 Project 多 Pi Session 并行运行
- [x] Parallel Agent overview
- [x] Agent state / busy / waiting / failed
- [x] 快速切换并行任务
- [x] Worktree cleanup

## P2.4 Remote Preview

- [x] Remote port detection
- [x] SSH port forwarding
- [x] WSL localhost mapping
- [x] Preview panel / external browser open
- [x] Preview lifecycle

---

# P3 — Productization

目标：提升可靠性、可维护性和正式发布质量。

- [ ] Settings 完整页面
- [ ] Connection 管理页面
- [ ] Pi diagnostics
- [ ] App logs / runtime logs
- [ ] Crash recovery
- [ ] Window / layout persistence
- [ ] Keyboard shortcuts
- [ ] Command palette
- [ ] Session full-text search（派生 FTS index）
- [ ] Import / Discover existing Pi projects UX
- [ ] Export session
- [ ] Auto update
- [ ] Windows installer
- [ ] App icon / branding 完成
- [ ] Startup performance 优化
- [ ] 大 Session performance 基准
- [ ] 大量 Session（1k+）索引性能基准
- [ ] SSH 高延迟环境测试
- [ ] Offline / disconnected Project UX

---

# Deferred / Explore Later

- ⏸ Cloud sync
- ⏸ Team collaboration
- ⏸ 自有 Agent runtime
- ⏸ 替代 Pi 的模型 / Tool / Skill 系统
- ⏸ 在本地同步 SSH 项目后运行 Pi

这些能力除非产品方向发生变化，否则不进入近期计划。

---

# Progress Log

按时间记录重要阶段即可，不需要记录每个 commit。

| Date       | Milestone                 | Status | Notes                               |
| ---------- | ------------------------- | ------ | ----------------------------------- |
| 2026-09-10 | Project initialized       | Done   | Tauri 2 + React 19 + Vite           |
| 2026-09-10 | WSL → Windows workflow    | Done   | rsync + inotify, Windows runtime    |
| 2026-09-10 | Oxc toolchain             | Done   | oxfmt + oxlint                      |
| 2026-09-10 | Frontend Style Foundation | Done   | Lody-based UI foundation            |
| 2026-09-11 | Developer Project         | Done   | Git / Terminal / Files / Editor     |
| 2026-09-11 | Remote & Parallel Power   | Done   | Helper / Watcher / Agents / Preview |

---

# Maintenance Rules

更新路线图时遵循：

1. 完成一个可验证的功能后，把对应 `[ ]` 改成 `[x]`。
2. 当前正在做的一级功能在标题或说明中标记 `🚧`。
3. 新需求优先放进已有阶段，不轻易增加新的 P-level。
4. `ROADMAP.md` 只记录长期产品路线与可验证的里程碑，不依赖临时任务状态文件。
5. 每完成一个 milestone，在 `Progress Log` 增加一行。
6. Roadmap 记录“做什么”和“做到什么程度”，具体设计和实现细节放在对应代码、文档或任务记录中。
