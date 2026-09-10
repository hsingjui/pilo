# Pilo Roadmap

> Pi-native desktop workspace for local, WSL, and SSH development.

Last updated: 2026-09-10

## Status

- [x] Done
- [ ] Todo
- 🚧 In progress
- ⏸ Deferred

## Product Direction

Pilo 的目标是提供一个面向 Pi Coding Agent 的桌面开发工作区，在不复制 Pi runtime 能力的前提下，统一管理：

- Local / WSL / SSH 开发环境
- Workspace 与项目上下文
- Pi Session 与历史记录
- Chat / Thinking / Tool Call
- Git / Diff / Terminal / File Explorer
- 后续的并行 Agent、Worktree 和 Remote Preview

核心原则：

1. **Pi owns conversations.** Pi JSONL 是 Session 的唯一事实来源。
2. **Pilo owns presentation and indexes.** SQLite 只保存可重建的索引、缓存和桌面状态。
3. **Pi runs where the workspace lives.** Local、WSL、SSH 都在代码所在环境运行 Pi。
4. **Connection、Workspace、Session 分离。** 不把环境、目录和 Pi Session 混成一个概念。
5. **Remote first.** 新能力优先考虑是否适用于 Local / WSL / SSH。

---

## Current Progress

### Project Foundation

- [x] 初始化 Tauri 2 + React 19 + TypeScript + Vite 项目
- [x] 建立 WSL 开发、Windows 运行的开发模式
- [x] 添加 WSL → `D:\Code\pilo` 实时同步脚本
- [x] 初始化 Git 仓库
- [x] 接入 Comet Native workflow（Pi）
- [x] 使用 `oxfmt + oxlint` 替代 Biome
- [x] 配置 `pnpm format` / `pnpm check` / `pnpm build`

### Current Focus

🚧 **Frontend Style Foundation**

Comet change: `docs/comet/changes/frontend-style-foundation/`

- [ ] 建立 Lody 风格的 light / dark design tokens
- [ ] 建立核心 shadcn/ui 风格基础组件
- [ ] 自托管 Inter / JetBrains Mono
- [ ] 接入统一图标体系
- [ ] 完成 Sidebar + Main + Composer 静态布局骨架
- [ ] 支持 Light / Dark / System 主题切换
- [ ] `pnpm check` / `pnpm build` 通过
- [ ] Windows 下完成一次视觉验证

---

# P0 — Usable Pi Desktop

目标：Pilo 可以真正作为 Pi 的日常桌面客户端使用。

## P0.1 UI Foundation

- [x] 拆分巨型组件文件：`app-sidebar.tsx` (857 行) → `src/components/sidebar/`，`App.tsx` (583 行) → `title-bar` / `sidebar-footer` / `new-chat-landing` / `right-sidebar`
- [ ] 完成 Frontend Style Foundation
- [ ] 建立应用主布局
- [ ] 建立 Sidebar / Workspace / Session 基础组件
- [ ] 建立 Chat Message / Thinking / Tool Call 基础视觉
- [ ] 建立统一 Toast / Dialog / Dropdown / Tooltip 等基础交互
- [ ] 建立基础空状态、加载状态和错误状态

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

- P0.3–P0.5 的 Local / WSL / SSH launcher 必须保留 Pi 正常的 user/global/project extensions 加载语义，生产启动参数不得使用 `--no-extensions`。

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

- [ ] Local Connection 数据模型
- [ ] 检测本机 Pi 可执行文件
- [ ] 检测 Pi 版本
- [ ] 在指定 Workspace 启动 `pi --mode rpc`
- [ ] 展示 cwd / Git branch / Pi version 等环境信息
- [ ] 对启动失败、Pi 不存在、RPC crash 给出明确错误

## P0.4 WSL Connection

- [ ] WSL distro 枚举
- [ ] WSL Connection 数据模型
- [ ] 通过 `wsl.exe` 在目标 distro / cwd 启动 Pi RPC
- [ ] RPC stdio 正确桥接到 Windows Tauri
- [ ] 获取 WSL 内 Pi / Node / Git 环境信息
- [ ] 支持 WSL Connection 重连
- [ ] 验证当前主要开发环境 Debian

示意：

```text
Windows Tauri
    ↓ wsl.exe
WSL Debian
    ↓
pi --mode rpc
```

## P0.5 SSH Connection

- [ ] SSH Connection 数据模型
- [ ] 使用系统 OpenSSH `ssh`
- [ ] 兼容 `~/.ssh/config` host alias
- [ ] 兼容 SSH Agent / IdentityFile / ProxyJump / known_hosts
- [ ] Pi RPC 使用 non-interactive、no-PTY 模式
- [ ] 防止 banner / MOTD / shell stdout 污染 RPC JSONL
- [ ] SSH 断线状态与重连
- [ ] 基础连接测试和环境诊断

## P0.6 Workspace

- [ ] Workspace 数据模型
- [ ] Connection → Workspace 层级
- [ ] Local Folder 添加 Workspace
- [ ] WSL Workspace 添加 / 最近使用
- [ ] SSH Workspace 添加 / 最近使用
- [ ] Workspace metadata 本地缓存
- [ ] Recent Workspaces
- [ ] 环境指示器：Connection / cwd / branch / Pi version
- [ ] Discover existing Pi Workspaces

原则：

```text
Connection
    ↓
Workspace
    ↓
Session
    ↓
Pi RPC Process
```

## P0.7 Session Index

- [ ] 引入本地 SQLite
- [ ] `connections` 表
- [ ] `workspaces` 表
- [ ] `sessions` 派生索引表
- [ ] Workspace 打开时先读 SQLite，立即展示缓存
- [ ] 后台扫描 Pi Session JSONL metadata
- [ ] 使用 `session_path + file_size + file_mtime_ns` 判断 stale
- [ ] 新 Session 自动加入索引
- [ ] 删除 Session 自动移除索引
- [ ] changed Session 增量重新解析
- [ ] 保存 `last_offset`，对 append-only JSONL 做增量解析
- [ ] Workspace focus / reconnect 时 reconcile
- [ ] 保留手动 Refresh Sessions

SQLite 只保存可重建 metadata，例如：

```text
connection_id
workspace_id
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

## P0.8 Session UI

- [ ] Sidebar 默认展示当前 Workspace 全部 Pi Sessions
- [ ] 按 Today / This Week / Older 分组
- [ ] Session title / preview / updated time
- [ ] Pin
- [ ] Archive / Hide（Pilo UI 状态，不修改 conversation truth）
- [ ] Session Search（metadata）
- [ ] 新建 Session
- [ ] Resume Session
- [ ] Session rename
- [ ] Session switch
- [ ] Session list virtualization

## P0.9 Pi Chat

- [ ] `prompt`
- [ ] Streaming assistant output
- [ ] Thinking 展示
- [ ] Tool call / tool result 展示
- [ ] `abort`
- [ ] `follow_up`
- [ ] `steer`
- [ ] Model selector
- [ ] Thinking level selector
- [ ] Session name / state
- [ ] Token / cost / context 基础状态
- [ ] Markdown / code block 渲染
- [ ] 大消息与 Tool Result 折叠
- [ ] 长 Session 渲染 virtualization

## P0.10 Pi Extension UI Bridge

- [ ] `select`
- [ ] `confirm`
- [ ] `input`
- [ ] `editor`
- [ ] `notify`
- [ ] `status`
- [ ] `widget`
- [ ] `title`

目标是尽量不牺牲 Pi extension 生态兼容性。

## P0 Exit Criteria

- [ ] Local Pi 可以完成完整聊天流程
- [ ] WSL Pi 可以完成完整聊天流程
- [ ] SSH Pi 可以完成完整聊天流程
- [ ] CLI 新建/修改 Session 后 Pilo 能自动看到变化
- [ ] 退出 Pilo 后 Pi JSONL 不受破坏
- [ ] 删除 Pilo SQLite 后可完整重建 Session 列表
- [ ] Windows 端可连续稳定使用作为日常 Pi Client

---

# P1 — Developer Workspace

目标：从“Pi Chat 客户端”升级为完整 Coding Workspace。

## P1.1 Git

- [ ] Remote-aware `git status --porcelain`
- [ ] Branch 信息
- [ ] Changed files 列表
- [ ] Working tree diff
- [ ] Staged diff
- [ ] Diff viewer
- [ ] File ↔ Diff 快速跳转

## P1.2 Terminal

- [ ] Terminal dock
- [ ] Local shell
- [ ] WSL shell
- [ ] SSH shell
- [ ] Terminal 与当前 Connection / Workspace 绑定
- [ ] 多 Terminal tab
- [ ] Terminal resize / persistence

## P1.3 Files

- [ ] RemoteFs abstraction
- [ ] `readDir`
- [ ] `readFile`
- [ ] `writeFile`
- [ ] `stat`
- [ ] `mkdir`
- [ ] `rename`
- [ ] `remove`
- [ ] File Tree
- [ ] 文件搜索

## P1.4 Editor

- [ ] Monaco editor
- [ ] 文件 tab
- [ ] Dirty state
- [ ] Save
- [ ] Diff → Editor
- [ ] Tool call 中的文件路径可直接打开

## P1 Exit Criteria

- [ ] 不离开 Pilo 即可完成常规查看代码 / Git diff / Terminal 操作
- [ ] Local / WSL / SSH 三种环境的 Git / Terminal / File 基础能力行为一致

---

# P2 — Remote & Parallel Power

目标：把 Pilo 做成 Pi 的 remote-first 高级工作区。

## P2.1 Remote Helper

- [ ] 定义 helper protocol
- [ ] WSL helper deployment
- [ ] SSH helper deployment
- [ ] `session.scan`
- [ ] `session.stat`
- [ ] `session.watch`
- [ ] `fs.*`
- [ ] `git.*`
- [ ] helper version negotiation / upgrade

## P2.2 Session Watcher

- [ ] Local filesystem watcher
- [ ] WSL inotify watcher
- [ ] SSH remote watcher
- [ ] watcher disconnect fallback 到 reconcile
- [ ] reconnect 后 full metadata reconciliation

## P2.3 Worktree & Parallel Agents

- [ ] Git worktree 管理
- [ ] 一个 Workspace 多 Pi Session 并行运行
- [ ] Parallel Agent overview
- [ ] Agent state / busy / waiting / failed
- [ ] 快速切换并行任务
- [ ] Worktree cleanup

## P2.4 Remote Preview

- [ ] Remote port detection
- [ ] SSH port forwarding
- [ ] WSL localhost mapping
- [ ] Preview panel / external browser open
- [ ] Preview lifecycle

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
- [ ] Import / Discover existing Pi workspaces UX
- [ ] Export session
- [ ] Auto update
- [ ] Windows installer
- [ ] App icon / branding 完成
- [ ] Startup performance 优化
- [ ] 大 Session performance 基准
- [ ] 大量 Session（1k+）索引性能基准
- [ ] SSH 高延迟环境测试
- [ ] Offline / disconnected Workspace UX

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

| Date       | Milestone                 | Status      | Notes                            |
| ---------- | ------------------------- | ----------- | -------------------------------- |
| 2026-09-10 | Project initialized       | Done        | Tauri 2 + React 19 + Vite        |
| 2026-09-10 | WSL → Windows workflow    | Done        | rsync + inotify, Windows runtime |
| 2026-09-10 | Comet Native workflow     | Done        | Pi project integration           |
| 2026-09-10 | Oxc toolchain             | Done        | oxfmt + oxlint                   |
| 2026-09-10 | Frontend Style Foundation | In progress | Lody-based UI foundation         |

---

# Maintenance Rules

更新路线图时遵循：

1. 完成一个可验证的功能后，把对应 `[ ]` 改成 `[x]`。
2. 当前正在做的一级功能在标题或说明中标记 `🚧`。
3. 新需求优先放进已有阶段，不轻易增加新的 P-level。
4. Comet change 可以记录在对应任务下面，但 `ROADMAP.md` 是长期产品路线图，不依赖 Comet 状态文件。
5. 每完成一个 milestone，在 `Progress Log` 增加一行。
6. Roadmap 记录“做什么”和“做到什么程度”，具体设计和实现细节放进 Comet change / spec。
