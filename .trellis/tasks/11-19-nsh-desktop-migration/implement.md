# 桌面端迁移到 nsh · 执行计划

## 前置

- PRD 的 Open Questions 全部确认，`design.md` 按结论更新。
- 分支 `nsh-migration`，基于 `main`。
- 每周把 `main` 合入 `nsh-migration` 一次；合入后跑一遍“验证命令”中的 Rust 与 WebUI 部分，确认分支上的 Tauri 版仍可用。
- 每个里程碑是一个子任务，按 Trellis 流程单独规划、实现、检查、归档；后续子任务在前一个结束时创建，避免计划过期。

## 任务图

| 里程碑 | 子任务 | 交付物 | 替换的现有代码 | 依赖 |
|---|---|---|---|---|
| M0 | `11-19-nsh-m0-risk-spikes` | 四项风险结论 + 继续/中止决定 | — | — |
| M1 | 运行时抽离与地基 | `src-tauri` 运行时去 Tauri 依赖（原路径）；`desktop/` 骨架、主题、图标、基础组件、i18n；功能对齐清单 | `src/ui`（2,154 行）、`src/styles`（1,150 行） | M0 |
| M2 | 桥接与数据层 | `Pilo` Rust 模块覆盖 `PiloClient`；signal 状态；应用启动、项目与会话列表 | `src/lib/api`（3,623 行）、`components/app`（3,958 行） | M1 |
| M3 | Chat | 消息列、工具活动、Markdown、Diff、Composer、队列、模型与运行配置 | `components/chat`（19,306 行） | M2 |
| M4 | 侧边栏与设置 | 项目树、会话行、搜索、Connection 管理、全部设置页、命令面板 | `components/sidebar`（2,695 行）、`components/settings`（6,091 行） | M2 |
| M5 | 工作区面板 | 终端、Git 工作区与 diff、项目文件查看、图片查看 | `terminal-*`、`git-*`、`project-viewer` | M3 |
| M6 | 桌面壳 | 托盘、快捷键、单实例、开机启动、窗口状态、通知、自动更新、标题栏 | `src-tauri/src/desktop_*.rs`、Tauri 插件 | M2 |
| M7 | 发版切换 | 三平台打包流水线、Windows 全量验证、数据兼容、更新过渡、删除 Tauri | `src-tauri/`、`release.yml` | M3–M6 |

M4、M5、M6 互不依赖，可在 M3 之后任意顺序进行。

## 步骤

### M0 风险验证

见子任务 PRD。产出回写 `design.md` 中所有“待 M0 验证”项。

### M1 运行时抽离与地基

1. 按 `design.md` 第 3 节在原路径上去掉运行时的 Tauri 依赖（不移动文件），Tauri 壳放到 `tauri` feature 之后；分支上的 Tauri 版回归通过。
2. 建立 `desktop/`：`nsh.json`、`theme.json`、字体、`native/` crate 空壳。
3. 构建期脚本：主题 CSS → token JSON；`lucide-react` → 图标数据。
4. 自定义主题 token 表：定义格式与 token 清单、共用校验逻辑、Rust 侧旧 CSS 转换与转换报告；WebUI 改为按 token 表注入变量并换成 token 编辑界面。
5. 基础组件：按钮、图标按钮、输入、弹层、菜单、对话框、tooltip、toast、tabs、select、开关、滚动条。
6. i18n 接入，确认现有资源可直接使用。
7. 产出功能对齐清单（逐个页面、逐个交互，标注必须 / 可延后 / 放弃）。
8. 列出 WebView `localStorage` 键及处理方式。
9. 写入 `.trellis/spec/` 的 nsh 桌面端规范初稿；更新 `AGENTS.md` 过渡期规则。

### M2 桥接与数据层

1. `Pilo` 模块：先 `bootstrap`、偏好、主题、项目、会话列表，再聊天控制与事件流。
2. `nshPiloClient` 实现 `PiloClient`；复用 `src/lib` 纯逻辑。
3. 应用级状态：catalog、会话索引、未读、导航，改写为 signal。
4. 应用外壳：标题栏、侧边栏占位、主区域路由、启动与错误界面。

### M3 Chat

1. 历史加载与窗口化、消息列表、粘底与回到底部。
2. 助手消息：流式 Markdown、代码块、表格、图片、链接、文件链接。
3. 工作活动：三级折叠、各工具渲染、diff、todo 胶囊、agent 活动、compaction。
4. Composer：多行、输入法、`@` 文件与会话提及、命令建议、附件、粘贴与拖入、输入历史、草稿。
5. 发送流程：steer / follow-up 队列、中止、恢复提示、下一句建议、提示词增强。
6. 模型选择、thinking 控制、上下文用量、session header 与菜单、fork。
7. Pi 扩展 UI 对话框与通知。
8. 对话大纲（outline rail）：条目列表、点击跳转、滚动时高亮当前条目。
9. 延后项的替代表现：Mermaid 代码块显示源码；不提供查找入口。

### M4 侧边栏与设置

1. 项目树、会话虚拟行、未读、最近分区、搜索、会话菜单、项目排序（菜单“上移 / 下移”，拖拽延后）。
2. 新建会话落地页、项目选择、添加项目对话框。
3. 设置：外观（含主题编辑）、字体、连接（Local / WSL / SSH 编辑器与诊断）、模型目录、缓存保活、下一句建议、提示词增强、会话命名、通知、快捷键、Remote、桌面、关于。
4. 命令面板。

### M5 工作区面板

终端 dock（`Terminal` + 现有 PTY）、Git 工作区、diff 查看、项目文件与图片查看、HTML 报告链接。

### M6 桌面壳

按 `design.md` 第 7 节逐项替换并验证；改写 `pnpm debug:desktop` 对应的调试入口。

### M7 发版切换

1. 把 `src-tauri/src/runtime` 与 `domain` 搬到 `crates/pilo-runtime`。
2. 三平台 `nsh package` 流水线，内嵌 WebUI 与 `pilo-server` 资源。
3. Linux 打包脚本：在 `nsh package --target linux` 的产物上生成 `deb`、`rpm`、`AppImage`；构建机升到 `ubuntu-24.04`；改写 `tests/packaging` 的 AppImage 测试。
4. Windows 全量验证（PRD 验收项）；macOS 冒烟；Linux 三种包各验证一次。
5. 现有数据目录升级验证。
6. 更新过渡方案落地。
7. 性能对比记录。
8. 删除 `src-tauri/` 壳与 `src/` 中仅桌面端使用的文件；更新 `AGENTS.md`、README、spec。
9. 发版前向用户确认版本号。

## 验证命令

```bash
# Rust
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p pilo --lib --no-default-features   # 去 Tauri 依赖后的运行时

# nsh 桌面端（desktop/ 目录）
nsh check
nsh test
nsh test --target macos      # 或 windows / linux，原生截图与真实输入
nsh run --target macos

# WebUI 与共享逻辑
pnpm format
pnpm check
pnpm build
pnpm test:unit
```

## 评审点

- M0 结束：继续 / 中止。
- M1 结束：功能对齐清单确认。
- M3 结束：Chat 与 Tauri 版逐项对照演示。
- M7 开始前：发版切换确认。

## 回滚点

- M1 的运行时抽离是独立提交序列，出问题可单独回退，不影响 nsh 代码。
- M0–M6 期间 `main` 完全不受影响；中止迁移只需停用 `nsh-migration` 分支，`main` 无需任何回退。
- M7 删除 Tauri 的提交单独成组，保留一个版本周期后再清理。
