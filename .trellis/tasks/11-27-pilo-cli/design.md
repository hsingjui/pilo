# 设计：Pilo 终端 CLI

基线：`main`（含 host 拆分 #45，原基于 `devin/host-decouple` @ `fbae4361` 编写）。以下是拟实现的契约，不是当前分支已交付的功能。

## Host 边界与本机 IPC

`pilo` 是独立的短命 Rust 客户端（`crates/pilo-cli`），不打开 SQLite、不直接启动 Pi，也不在 CLI 内创建 Runtime。桌面仍由 `App.tsx:9–17` 和 `crates/pilo-desktop/src/pilo/mod.rs:137–184` 启动唯一的嵌入式 Host。桌面 `NativeTransport`、远程 `HttpTransport`、CLI 本机 IPC 最终都分发到 `crates/pilo-runtime/src/host_api/mod.rs` 的同一方法表及业务 handler。Remote WebUI 的 HTTP/WS、设备配对和 scope 不变。

- CLI 默认连接打包时编入的 App ID：正式包 `pilo` 为 `app.hsingjui.pilo`，开发包 `pilo-dev` 为 `app.hsingjui.pilo.dev`。保留 `--dev` 覆盖为开发版；不检测 `argv[0]`，不从 `debug_assertions` 推断实例，连接失败不回退到另一实例。包标识见 `nsh.json:2–3,16`、`.github/workflows/release.yml:64–65`；macOS 数据目录见 `pilo/shell.rs:516–528`。Host 创建与回收端点，真正退出关闭 IPC；关窗仅隐藏时仍可用（`app/shell/desktop-shell.ts:166–196`）。
- macOS 端点为 `~/Library/Application Support/<app id>/pilo.sock`；Linux 为 `$XDG_RUNTIME_DIR/pilo/<app id>.sock`。Unix 路径超过 100 字节（macOS `sun_path` 为 104 字节），或 Linux 没有 `XDG_RUNTIME_DIR` 时，改用 `/tmp/pilo-<uid>/<app id>.sock`。CLI 与 Host 按同一规则派生路径，无发现文件。socket 权限为 `0600`；回退目录为 `0700`，Host 验证其所有者是当前用户且不是符号链接。Host 启动只在既有端点确为当前用户的 socket 且连接被拒绝（`ECONNREFUSED`）时删除并重绑；连接成功或其他错误时不清理。
- Windows 端点为 `\\.\pipe\pilo-<app id>-<user SID>`，ACL 仅当前用户，拒绝远程连接。各平台由 Host 校验 OS 对端身份并赋予 `Principal::Local`；客户端不能自报权限。不配对，不需要 token，不开 TCP 端口，不依赖 Remote WebUI。

### IPC 帧与握手

- 每帧为 **4 字节大端无符号长度 + UTF-8 JSON**；长度只计 JSON 字节，最大 **16 MiB**，读正文前拒绝超限声明。
- 首帧为 hello：CLI 发送 `{"protocol":"2.0","client":"pilo-cli","version":"<cli version>"}`，Host 成功回复 `{hostId, appVersion, capabilities, installation:{source,path}}`。握手上限 **5 秒**；协议主版本不兼容则返回明确错误，同主版本的 App 补丁差异不挡调用。`installation` 只随本机 IPC 返回：`source` 为 `installed`、`portable` 或 `appimage`，`path` 为当前 App 的规范化绝对路径（macOS 为 .app，Windows/Linux 普通包为应用目录，AppImage 为原始镜像文件）。`hostId` 来自 App 数据目录的 SQLite，不能用于区分同标识的安装版和便携版（`crates/pilo-runtime/src/storage/remote.rs:40–64`）。
- 请求为 `{id, method, params}`，方法及参数与 `/api/v2/call` 一致；响应为 `{id, result}` 或 `{id, error:{code,message}}`。请求默认超时 **60 秒**，可用 `--timeout` 覆盖，不改变 hello 上限。预留 `{event}` 帧给以后 `sessions send --wait`，本期不发送。断连后不自动重放已提交的写请求。

## 方法合同与命令

`scripts/generate-host-api.mjs` 当前从 Runtime 方法表生成 `shared/api/host-methods.json`，`shared/api/host-client.ts` 消费共享方法合同。扩展同一产出链，补齐所需参数/返回类型描述，从 JSON 为 Rust 生成方法及类型绑定，也让 TS HostClient 与该合同保持一致；避免维护第二套手写方法名/类型。保留 Rust handler 注册表到 JSON 的生成方向，不让 Runtime 反向依赖 CLI；构建不能要求先运行另一个目标平台的二进制。

| 命令 | 对应 Host API / 语义 |
| --- | --- |
| `settings get\|patch`、`settings theme get\|set` | `preferences.get/patch`、`theme.get/set`（`host_api/handlers.rs:249–260`）；偏好是字段级 patch，不直接写文件。 |
| `projects list\|add\|remove` | `project.list/add/remove`（`host_api/handlers.rs:77–86`）；添加沿用连接环境的路径校验和 Host 工作区生命周期。 |
| `sessions list\|get\|history` | `session.list/history` 和 `chat.state`；按项目解析会话 ID，不接收任意 JSONL 路径。列表/历史支持有界分页。 |
| `sessions status <id>` | 用 `chat.state` 和 `chat.transcript` / `session.history` 读一次快照；不启动 Pi。 |
| `sessions create\|send\|abort\|stop` | 复用 `chat.start/rpc/stop` 与 `control/sessions.rs:56–275,371–467` 的高层语义，而非复制业务。必要时把「启动并等待首条 prompt 回执」等跨调用逻辑迁至共享 Host handler。 |
| `sessions archive\|restore\|delete\|update` | 归档/恢复由 `session.uiState.set` 加 `archived: true/false`；update 补丁修改标题/置顶，不重写缺省字段；删除走 Host 的安全回收路径，不自行 unlink。见 `shared/api/host-client.ts:345–371`、`crates/pilo-runtime/src/host_api/handlers.rs:336–348`。 |
| `open [path]`、`open --session <id>`、`version`、`--help` | open 走 OS 打开应用，带目标时才做导航；version 和 help 不需要 Host。 |

- create/send 接收 stdin JSON（如 `{"message":"…","title":"…"}`，title 仅 create）；拒绝空消息、slash 命令及忙目标，不偷偷排队。create 仅在 Pi 对首条 prompt 给出关联回执后报告接受，不等待生成结束；明确未提交/被拒绝时回收新启动的 Pi，结果未知时保留会话并返回可查询的 key。send 可恢复已有会话；abort 只中断当前轮，stop 关闭受管进程并保留历史。删除前检查受管进程占用，不隐式停止会话；会话数据仍以 Pi JSONL 为准。
- 面向 skill / Pi 插件的稳定接口是命令、项目/会话 ID、stdin schema、stdout 单个 JSON 值和稳定错误类别，而不是内部 RPC 拼装细节。成功退出 0；错误退出非 0，诊断走 stderr，不能把人类日志混进 stdout；help 是文本例外，version 至少输出 CLI 版本。错误区分离线、协议不兼容、无效输入、明确拒绝和写入结果未知，未知结果应建议查询而非重试。按命令在公开文档中固定字段、错误和示例。
- 桌面专有设置（退出行为、系统快捷键等）当前仍由 `crates/pilo-desktop/src/pilo/mod.rs:314` 起的原生桥负责，不假定都在 v2 方法表中；首批 `settings` 合同为偏好和主题。完整本机 Host scope 包括现有 admin 方法（例如 `connection.ssh.password`），所以端点必须以 OS 用户隔离；CLI 命令本身不提供任意 invoke，也不把凭据塞入设置快照或诊断输出。

### 会话状态

`pilo sessions status <id>` 由 Host 索引定位会话，只查 Host 已有状态，不启动或恢复 Pi。读取 `chat.state` 的进程状态、`activeTurn` 和 `compacting`；运行中的会话再查 `chat.transcript` 的当前轮和历史尾部。快照不可用时可用 `session.history` 读取已完成回复，但不能用历史推断进度。Pi 的正常消息在 `message_end` 时才持久化，CLI 不直接读或 tail JSONL 来判断进度。见 `crates/pilo-runtime/src/host_api/handlers.rs:322–329,369–377`、`crates/pilo-runtime/src/transcript.rs:21–36`。

成功时 stdout 输出单个 JSON 对象，以下字段总是存在：

| 字段 | 类型与语义 |
| --- | --- |
| `sessionId` | 字符串，解析后的完整会话 ID。 |
| `state` | `idle`、`running`、`compacting`、`not_running`、`error`。进程失败取 `error`，无受管进程或已停止取 `not_running`；否则压缩优先于活跃轮，有活跃轮或 Pi 正启动取 `running`，其余为 `idle`。 |
| `turn` | `idle`、`active`、`truncated` 或 `null`；对应 `chat.transcript.live.type`，无快照时为 `null`。 |
| `runningTools` | 工具名称字符串数组或 `null`。从完整当前轮按工具调用 ID 匹配开始与结束；能判定且没有工具运行时为 `[]`，快照截断或不可用时为 `null`，不把未知当作正在生成。 |
| `lastAssistantMessage` | 最近一条可从历史读取的已完成 assistant 消息的文本，无法取得时为 `null`；不把生成中的文字当已完成回复。 |

`state: "error"` 表示成功查询到会话进程失败；Host 离线、会话找不到或查询失败仍走正常命令错误，不能当作会话未运行。实时 `sessions watch`、回答扩展 UI 请求和 `sessions send --wait` 均不在本期。

## 启动与定位

- `pilo open`：通过 OS 启动或激活 PATH 入口指向的 CLI 所属的 App，不按系统安装位置猜测。安装版与便携版并存时，以最后在「设置 → CLI」成功安装或修复该入口的 App 为准；切换时去另一份 App 安装或修复。即使不带导航参数，也须限时等待 hello，并把 Host 报告的 `installation` 与所选入口关联的安装位置和来源比对；目标缺失时提示修复，遇到同标识的另一份运行实例时提示先退出，不导航、不报告成功、不回退到另一份 App。
- `pilo open <path>`：以调用方 cwd 解析相对路径；Host 规范化目录后匹配 Local 项目，未登记时走 `project.add` 生命周期，再导航到项目。
- `pilo open --session <id>`：Host 从会话索引解析所属项目，支持完整 ID 或唯一前缀；无匹配则报错，多条匹配时列出候选，不猜测目标。不接受 JSONL 路径，也不与目录参数混用。

OS 启动和激活仍复用 nsh 单实例行为，不创建另一个 Runtime。nsh 0.7.2 的 `secondInstance` 在 Windows/Linux 提供 `{args,cwd}`，macOS 不发该事件，因此不靠启动参数传导航目标（`nsh-core-0.7.2/src/runtime/desktop.rs:133–149`、`app/shell/desktop-shell.ts:181–185`）。比对安装来源后，导航通过本机 IPC 送给桌面本机视角，即使当前显示远端 Host；不向 Remote WebUI 广播。冷启动等待 UI 注册，导航成功与否有明确回执。

其它需要 Host 的命令只有带 `--launch` 才启动 App 并限时等待 IPC hello；启动时同样核对目标安装，核对后才发业务请求。Host 未运行且无此参数时返回运行 `pilo open` 的提示。重试只发生在连接/握手阶段，不能再次发送已交付的命令。

## 随 App 安装与更新

- 发布矩阵在 `.github/workflows/release.yml:210–233` 现有资源 staging 阶段加入当前 OS/架构的一个 CLI，放在专用的 `Contents/Resources/bin/`（macOS）或桌面可执行文件旁的 `bin/`（Windows/Linux）。正式包为 `pilo`（Windows 为 `pilo.exe`），开发包为 `pilo-dev`（Windows 为 `pilo-dev.exe`）；该目录仅放 CLI，不混入仍在 `runtime/` 的 `pilo-server-*`。CLI 用同一 App 版本，在最终签名和归档前加入。签名更新流程沿用 `app/README.md:267–294`。
- 打包流程将最终 App manifest 的 ID 作为编译期输入传给 CLI 构建，并编入默认实例常量。正式包传 `app.hsingjui.pilo`，开发包传 `app.hsingjui.pilo.dev`；开发包即使用 release profile 也保持开发版默认值。
- `app/settings/settings-dialog.tsx` 的 `SETTINGS_TABS` / pane switch 在「其他 → 关于」旁加桌面专用「CLI」页，原生适配器负责检测/安装/卸载/修复。显示未安装、就绪、不在 PATH、失效/指向其它版本、冲突等状态，以及安装路径、版本和可执行动作；WebUI 不渲染此页。
- macOS 默认经一次系统管理员授权在 `/usr/local/bin/pilo` 建立指向 App 内 CLI 的软链；取消授权时改装到 `~/.local/bin/pilo`，提示如何把目录加入 PATH，不修改 shell 配置。卸载或修复 `/usr/local/bin` 的链接同样请求授权，取消则不动原链接；授权只用于链接操作，运行 CLI 不需要提权。Linux deb/tar 仍链接到 `~/.local/bin/pilo`，目录不在 PATH 时给出说明。
- Windows 不生成 `pilo.cmd`，去重追加 App 的专用 `bin` 目录到**用户** PATH，提示重开终端，不改系统 PATH。Setup 的实际路径是 `{app}\pilo-app\bin\pilo.exe`，便携版则是解压后的 `<应用目录>\bin\pilo.exe`。nsh 原地更新保持目录稳定，不重写 PATH；移位、解压到别处或主动切换时，通过设置替换旧的自有 PATH 项。卸载 CLI 只清理其管理的 PATH 项，不删除 App 打包的 EXE（`app/README.md:285–294`、`.github/workflows/release.yml:246–252`）。
- dev 命令与正式版并存且互不覆盖。记录链接/目录的所有权、目标及 PATH 段是否由 Pilo 新增；安装/卸载/修复须幂等且先核实所有权，仍有另一入口在用时不移除共享 PATH 段。
- 安装位置被第三方占用时提示：「`~/.local/bin/pilo` 已存在且不是 Pilo 创建的，未覆盖。请手动处理后重试。」PATH 前序条目遮蔽时提示：「PATH 中的 `/opt/homebrew/bin/pilo` 优先，终端执行 pilo 不会使用 Pilo CLI。」实际填入检测到的路径与命令名（含 dev 版）；不自动覆盖、删除或重排第三方条目。
- Linux AppImage 将 `$APPIMAGE` 的原始镜像路径提供给原生层，供安装记录和 hello 使用；当前 `nsh.json:36–38` 只向 UI 暴露 `PILO_APPIMAGE` 标记，不提供原始路径。安装时把 CLI 复制到 `~/.local/share/pilo/bin/pilo`，让 `~/.local/bin/pilo` 链接到此持久副本，不指向临时挂载目录。CLI 仍处于已安装状态且关联当前 AppImage 时，每次 App 启动比较副本和 App 版本，不同则原子替换自有副本；不重装已卸载的 CLI。dev AppImage 使用独立的 `pilo-dev` 副本与链接。CLI 调用 Host 只依赖 socket，不依赖 AppImage 挂载。
- 其他安装形态原地更新替换 App 内 CLI，PATH 引用不动，不另建升级器。启动时检查断链、移位或版本不符；显示修复，只有能无歧义确认自有引用时才允许自动改写，不后台请求提权，也不能自动把入口切到另一份 App。

## 评估过但不纳入首版的方案

- 不在 Unix socket / named pipe 上复用整套 Axum HTTP/WS 网关。请求路由可抽出，但 `/events` 仍耦合设备 token 和 Remote WebUI 启停；首版没有实时订阅或文件传输，用现有长度帧复用 Host 方法即可（`crates/pilo-runtime/src/remote/api/v2.rs:331–439,445–479`）。
- 暂不提供通用的 `pilo api`，只发布有稳定输入输出的命令。
- 不注入 `PILO_SESSION_ID` / `PILO_PROJECT_ID`。旧 ctl 也未注入这两个变量；来源保存在 Host lease，由旧 `ctl status` 返回（`crates/pilo-runtime/src/control.rs:68–92,152–160,198–204`）。

## 旧入口移除与回滚

移除 `pilo-server ctl`、Host lease/dispatcher、控制协议消息和 listener，删除 Pi 启动提示、`PILO_CTL` / `PILO_CONTROL_*` / `PILO_REMOTE_CONTROL` 注入及 SSH bash 包装分支。保留 stdio Server、`--version` / `--fingerprint`、SSH bridge、Pi 会话业务和存储不变；替换 `.trellis/spec/backend/agent-control.md` 的旧规范。本机 Pi 将来用 PATH CLI；SSH/WSL 不做转发，不恢复旧能力。回滚以整个 App 和同包 CLI 一起回滚，检查/修复外部引用；不回滚 SQLite、Pi JSONL 或迁移用户数据。
