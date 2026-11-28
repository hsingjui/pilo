# 实施计划：Pilo 终端 CLI

状态：规划待评审，未执行 `task.py start`。以下命令和平台检查供实施时使用；新 crate / 测试须随对应步骤加入。

## 1. 增加桌面 Host 本机 IPC

- [ ] 在 `crates/pilo-desktop/src/pilo/` 接入 Host 启停；实现设计规定的 4 字节大端长度、UTF-8 JSON、v2 hello 和请求/响应。由 Host 与 CLI 共享端点派生规则；OS 用户校验后才使用 `Principal::Local`，Remote WebUI 开关不参与。
- 验证：`cargo build -p pilo-server && cargo test -p pilo-runtime host_api && cargo test -p pilo-runtime v2_dual_host_pairing_calls_scopes_origin_and_event_replay && cargo test --manifest-path crates/pilo-desktop/Cargo.toml`。先用测试客户端独立验证 hello、权限、拒绝未知或超限调用、断连、旧端点回收及 dev/release 同时运行。
- 平台门槛：测试 16 MiB 边界、坏帧、5 秒 hello 超时和主版本错误；macOS/Linux 检查 100 字节边界、Linux 缺少 `XDG_RUNTIME_DIR`、回退目录所有者/权限、仅连接拒绝的自有陈旧 socket 可重绑、活跃端点不删除。原生 Windows 核对 pipe 名称及 ACL，拒绝其它用户/远程连接。Remote WebUI 关时可用，打开后网关不回归；没有新增 TCP listener。

## 2. 新 CLI、合同生成与 Host 命令

- [ ] 新建 `crates/pilo-cli` 及 `pilo`；扩展 `scripts/generate-host-api.mjs` / `shared/api/host-methods.json` 的生成链和漂移检查。先复用现有 Host handlers，再迁移仍需的会话业务至共享层；不能依赖旧 lease 才能查找会话。
- [ ] 实现 settings / projects / sessions、help、version、默认 60 秒请求超时与 `--timeout`（不改变 hello 超时），固定 stdin/stdout、分页、错误类别及退出码；新增文档和 JSON 示例。通过进程测试检查命令解析与输出，通过 Host 集成测试检查副作用。
- [ ] CLI 用编译期 App ID 选择默认 IPC 实例，保留 `--dev` 覆盖；不检测 `argv[0]`，也不依赖 `debug_assertions`。不实现通用 `pilo api` 调用。
- [ ] 实现 `sessions status <id>`：用 `chat.state`、`chat.transcript` 和历史回退返回一次 JSON 快照；不启动 Pi、不订阅、不靠 JSONL 推断进度。验收覆盖空闲、运行（生成/工具）、压缩、未运行、进程失败、无最近回复，以及当前轮截断时不猜测工具；区分会话失败与查询失败，检查稳定字段和无启动副作用。
- 验证：`pnpm generate:host-api --check`、`cargo test -p pilo-cli`、`cargo test -p pilo-runtime`、`pnpm check`、`pnpm test:unit`。检查缺失/错误项目范围被拒绝、首条 prompt 仅提交一次、已接受不等待完成、明确失败回收、超时保留可查询 key；archive/restore 与更新不覆盖无关字段，删除不绕过回收或隐式停止。macOS/Linux/Windows 各做终端冒烟测试，覆盖双实例和不兼容版本。

## 3. 打开 App、导航与按需启动

- [ ] 在 CLI 接入平台打开/激活，复用 `nsh.json` / `app/shell/desktop-shell.ts` 单实例行为。由原生层提供安装位置和来源，hello 返回 `installation` 供启动后的目标核对。本机 Host 与 `app/shell/launch.tsx` / Host registry 增加导航接口、UI 就绪和回执。实现 `open`、`open <path>`、`open --session <id>` 和 `--launch`；待目标核对后经 IPC 导航，不靠 `secondInstance` 传参；由 Host 定位会话的所属项目。
- 验证：`cargo test -p pilo-cli`、`nsh check`、`nsh test`；三个平台验证冷启动、激活、相对路径/空格、已有与未登记项目、完整会话 ID / 唯一前缀 / 无匹配 / 歧义候选，以及从远端视角返回本机。失败不虚报导航成功，普通命令无 flag 不启动，带 flag 只执行一次。
- 补充验收：Windows/Linux 安装版与便携版并存时，`open` 只以 PATH 入口关联的 App 为目标；让另一份同标识 App 先运行，即使 `hostId` 一样，普通 `open` 也须报错，带目标的 `open` 不发送导航，`--launch` 不发送业务请求。退出旧实例并在目标 App 的设置中安装或修复后验证切换。目标移位时提示修复，不回退到另一份 App。macOS 验证无 `secondInstance` 参数时仍能导航。

## 4. 发布资源与桌面「CLI」页

- [ ] 在 `.github/workflows/release.yml` 打包每目标 CLI 并校验版本，将最终 App manifest 的 ID（正式 `app.hsingjui.pilo`、开发 `app.hsingjui.pilo.dev`）传给 CLI 构建。按包分别命名为 `pilo` / `pilo-dev`（Windows 加 `.exe`），放入专用 `bin/`（macOS 为 `Contents/Resources/bin/`）与 App 一起签名/归档；不改 `pilo-server-*` 的 `runtime/`。更新 `app/README.md` 本地打包说明。原生壳实现所有权校验、状态、安装、卸载、修复。通过 `app/settings/settings-dialog.tsx` 在 About 旁展示，只在本机桌面提供安装能力。
- 验证：`pnpm check`、`nsh check`、`nsh test`；以发布矩阵的 `nsh package --target <macos|windows|linux> --app-version <version> --out .nsh/release` 加资源 staging 检查实际安装包。三个平台都验证 install → 调用 → App 原地更新 → 版本同步 → 移位修复 → uninstall，以及 PATH 缺失/冲突、外部改写不能误删。macOS 检查 App 签名，Linux 检查 symlink 在实际安装形态可达，Windows 用原生终端检查用户 PATH、空格/引号参数、退出码及安装版/便携版；WebUI 不显示入口。
- 补充验收：`pilo` 与 `pilo-dev` 并存，分别连接打包时指定的实例；重命名 CLI 或用 release profile 构建开发包不改变默认实例，`pilo --dev` 仍能连接开发版。第三方占用和 PATH 遮蔽分别验证文案及无覆盖。Linux deb/tar 检查直链；AppImage 检查持久副本在挂载卸载后仍能执行、新旧 App 版本启动时同步副本，以及卸载 CLI 后再次启动 App 不重装。
- 平台补充验收：macOS 验证 `/usr/local/bin` 安装授权、取消时回退 `~/.local/bin` 并提示 PATH、卸载/修复需要授权且取消不动原链接。Windows 验证 `bin` 只有 CLI、没有 `pilo.cmd`、用户 PATH 去重、原地更新不重写 PATH，移位/重解压后可修复且不误删用户已有目录项。
- AppImage 验证原生层能取得原始 `$APPIMAGE` 路径，安装记录和 hello 均不使用临时挂载路径；挂载卸载后 `open` 仍能启动并核对所属 App，启动另一份 App 不自动改写已选入口。

## 5. 删除旧 ctl、更新规范

- [ ] 在新 CLI 可用后，删除 `crates/pilo-server/src/{main,control,lib}.rs` 的 ctl 入口/专用模块与 RPC 分支，移除 `crates/pilo-protocol/src/{control,lib}.rs` 的控制消息，以及 `crates/pilo-runtime/src/control.rs`、`control/`、`server_pi.rs`、`chat_sessions/session_start.rs` 中的旧控制链（保留步骤 2 已迁移的业务）。检查 `crates/pilo-server/src/runtime_streams/pi/` 与 `extensions/ssh-workspace.js` 的启动、退出、环境变量与远端片段，清理相关测试/fixture 和能力宣告。
- [ ] 用新契约替换 `.trellis/spec/backend/agent-control.md` 并更新索引/有效交叉引用；原 Trellis 历史任务保留。发布说明注明远端 Pi 失去旧能力，不提供兼容层；继续支持从本机 CLI 管理 SSH/WSL 项目。
- 验证：`cargo build -p pilo-server && cargo test -p pilo-server -p pilo-runtime`、`pnpm test:integration`。用 `rg -n 'PILO_CTL|PILO_CONTROL_|PILO_REMOTE_CONTROL|control\.(register|respond|revoke|request)' crates app web shared` 检查旧接入已清除，确认旧 ctl 明确失败而正常 stdio、version/fingerprint 和 SSH bridge 正常。macOS/Linux 验证 Local 与 SSH（含本机 Pi + SSH 工作区）；Windows 原生验证 Local 与 WSL，检查普通 Pi 功能不依赖旧能力。

## 合并门槛与回滚

- 执行仓库 `AGENTS.md` 的 Rust、TypeScript / 生成产物与 nsh 检查；可见设置页需桌面实测。按平台记录实际验证结果，不能用 macOS 替代 Windows/Linux。
- 步骤 1–4 可逐项验证，正式发布前完成步骤 5，不对外承诺两套 CLI。若发布后需回滚，回退 App 与 bundled CLI 同一版本，修复或移除确认自有的 PATH 引用；不改用户数据库与会话历史。
