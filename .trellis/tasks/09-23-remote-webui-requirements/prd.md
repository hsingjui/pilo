# Remote WebUI 需求梳理

## Goal

让用户离开电脑桌面后，可以通过手机浏览器可靠地查看并继续 Pilo 中的 Pi Session，同时不破坏现有 Desktop 的本地体验，也不让 Remote 反向侵入 Local / WSL / SSH Runtime。

第一版要验证的核心价值是：

> 手机上的 Pilo 是同一个 Pilo Host 的另一个客户端，而不是另一套独立 Agent 系统。

同时，WebUI 的产品体验以现有 Desktop Chat 为基准：

- 核心 Chat 行为、消息展示、Thinking / ToolCall、Composer、Model / Thinking Level、Context Usage 等尽量直接复用现有 Desktop 组件和业务规则。
- 不重新设计一套“移动版 Chat”，避免 Desktop / Web 长期产生交互和样式分叉。
- Mobile 只在确有设备差异的部分做适配，例如导航方式、布局密度、触控目标、safe area、软键盘和浏览器前后台恢复。

## User Value

- 离开电脑后仍能查看正在执行的 Session 和实时输出。
- 可以从手机继续对话、发送新任务或中止当前执行。
- Desktop 与 Web 看到同一份 Project / Session 状态，切换客户端不会产生两套会话。
- Remote 未启用时，Desktop 不承担额外网络暴露和远程基础设施成本。

## Confirmed Facts

以下事实来自当前仓库代码和 docs/remote-webui-architecture.md，不是本轮新做出的产品选择。

### Current runtime

- 当前没有 HTTP / WebSocket Remote Server，也没有 Axum/Actix/Warp 等 Web Server 依赖。
- Rust 已有 ChatSessions 注册表；Chat Session 的 Pi 进程由 Rust Runtime 持有，而不是直接由 React 组件持有。
- ChatSessionState 已包含 sessionKey、projectId、sessionPath、初始化状态、active turn 和 snapshot，可作为 Remote 状态建模的基础。
- 当前 App 退出时会停止全部 Chat Session、Project Pi Session、Watcher、Terminal 和 Server；因此当前生命周期仍是“Desktop 进程 = Pilo Host”。
- 当前 Local / WSL / SSH 均由 Pilo Host 统一通过 Connection / pilo-server 管理，浏览器没有直接连接 Runtime 的现有路径。

### Current event model

- Rust 已有 RuntimeEvent / RuntimeEventEnvelope 和 RuntimeEventSink 抽象。
- Session Runtime Event 已携带 sessionKey / projectId 路由信息。
- 当前 RuntimeEventBus 实际只保存一个 Tauri Channel 订阅者，不是多客户端广播总线；Remote Web + Desktop 并存前需要演进。
- 当前事件没有 Remote reconnect 所需的全局/Session 单调 sequence 与 replay contract。

### Current frontend

- 当前没有统一的 PiloClient / PlatformClient 接口。
- Chat 已有 chat-session-client.ts 作为一定程度的调用收口，但仍直接依赖 Tauri invoke 与 runtime event channel。
- Files / Terminal / Git / Preview / Parallel 等能力已大多收口到 src/lib/*，但这些封装仍是 Tauri Transport。
- 当前 UI 是 Desktop-first，尚无 Mobile layout / navigation。

### Existing architecture proposal

docs/remote-webui-architecture.md 已提出以下方向，当前可作为本轮收敛的基线方案，而不是自动视为最终产品决策：

- Desktop 保持 Tauri IPC/Event；Web 使用 HTTP + WebSocket。
- 共享 Application Service / Contract，不强制共享 Transport。
- Session 属于 Pilo Host，Desktop / Web 都只是 observer/controller。
- Mobile 不复制 Desktop Sidebar，优先独立 Mobile layout。
- Remote 默认关闭，并采用设备认证而不是固定共享密码；第一版权限模型已经收敛为“认证成功即拥有全部 Remote MVP 能力”。
- 第一版优先 Chat / Session 主链路，Terminal / 完整文件编辑等后置。

## Requirements

### R1. Single Host / Single Session Model

- 同一个 Session 必须由 Pilo Host 持有。
- Desktop 和 Web 连接到同一个 Session，不允许为 Web 额外启动一份同 ID 的 Pi Session。
- Desktop 发出的消息、Web 发出的消息、Agent 输出和 Session 状态在两个客户端间最终一致。
- 浏览器不得直接连接 Local / WSL / SSH 的 pilo-server 或 Pi process。

### R2. Remote Chat MVP

第一版产品范围已确定为 Chat / Session Remote Console：

- 查看 Connection / Project。
- 查看 Session 列表与历史消息。
- 新建 Session。
- 打开并继续已有 Session。
- 实时查看 Agent text / thinking / tool call 状态。
- 发送普通 prompt。
- Agent 忙碌时支持现有 steer / follow-up 语义（如果 Desktop 当前能力保持不变）。
- Abort 当前执行。
- 查看 context usage / model 等与继续会话直接相关的信息。
- 支持图片附件，并复用现有 Chat image/attachment contract；第一版不支持 PDF、文本、压缩包等通用文件附件。

### R3. Shared Business Contract

- Desktop 不迁移到 localhost HTTP。
- Tauri Adapter 和未来 Web Adapter 调用同一套 Rust Application Service / Runtime API。
- 前端业务层应逐步形成 transport-neutral client contract；业务组件不直接区分 invoke / fetch。
- 平台原生能力（Window、Updater、Native Notification、File Picker 等）与 Pilo 业务能力分离。

### R4. Realtime and Recovery

- HTTP 用于 command / query / snapshot / upload-download。
- WebSocket 用于 streaming / runtime events。
- 高频 text delta 等 streaming event 不按极小 token/字符产生无界 frame；必须支持 batch/coalesce。
- Mobile Web 必须处理断线、后台挂起、前台恢复和 reconnect。
- 重连后客户端必须能恢复到 authoritative state；不能假设 WebSocket 永不掉线。
- 第一版可采用“短断线 replay + 超出窗口后 snapshot reconciliation”，具体 replay buffer/sequence 方案在技术设计阶段确定。

### R5. Multi-client Consistency

- Desktop 与 Web 可以同时打开同一 Session。
- Session execution 不依赖哪个 UI 当前处于前台。
- Command 必须有明确的 Session routing，不能依赖“当前活动 Session”这种单客户端全局状态。
- 对同时写入导致的冲突，需要为发送、abort、session lifecycle 定义可预测语义；第一版不要求 presence/cursor 等协作功能。

### R6. Mobile-first Web UX

- WebUI 的主要使用设备是手机，但核心 Chat 体验仍以现有 Desktop Chat 为基准，而不是单独设计第二套 Mobile Chat。
- Message、Thinking、ToolCall、Compaction、Pending Queue、Composer、Context、Model / Thinking Level 等核心 UI 与业务交互应优先直接复用现有 Desktop 组件。
- Project / Session 导航可以使用 Drawer / Sheet 等更适合手机的交互，不要求原样复用 Desktop Sidebar。
- Mobile 适配聚焦设备差异：safe area、软键盘、触控目标、窄屏布局、单手操作、前后台切换和浏览器 viewport 行为。
- 共享组件如果需要兼容 Mobile，应通过 responsive props / class / 小范围能力扩展解决，避免在 Remote 下复制一个功能等价组件。
- Tauri Desktop 与 Mobile Web 可以拥有不同 Shell / Navigation，但进入 Chat 主视图后尽量保持同一套信息层级和操作语义。
- 第一版 WebUI 不对齐 Desktop 的全局快捷键体系；移动端以触控和显式按钮为主，避免引入依赖物理键盘的交互。
- Desktop Browser 第一版只要求功能可用与基本响应式；不为 Desktop Browser 单独再做第三套体验。

### R7. Security Boundary

- Remote 默认关闭；关闭时不监听 Remote 端口。
- 第一版 LAN 访问仍必须先完成 Magic Link / QR 认证，不能把“能访问局域网端口”视为授权。
- 不以固定长期密码、账号体系或 OAuth 作为第一版认证方案。
- 认证成功后拥有第一版 Remote WebUI 暴露的全部能力；第一版不设计权限分级。
- Web 客户端不能绕过 Pilo Host 的 Connection / Project 边界访问未暴露能力或构造任意宿主绝对路径。

### R8. Compatibility / Non-regression

- Remote 未开启时，Desktop 启动、Session、streaming、Files、Terminal 等现有行为不应因 Remote 架构而引入新的网络依赖。
- Phase 1 的解耦原则上不改变 Desktop 用户可观察行为。
- 现有 Local / WSL / SSH Connection 语义保持不变。

## Out of Scope for MVP

除非后续明确改变范围，第一版暂不包含：

- 完整 Terminal 控制。
- Desktop 全局快捷键 / command palette 快捷键体系。
- 完整文件编辑器 / Git GUI。
- PDF、文本文件、压缩包等通用文件附件 / 文件上传。
- 完整 Settings / Updater / Window / Tray 等 Desktop 能力映射。
- Browser 直接管理 Pi process。
- Browser 直接连接任意 WSL / SSH runtime。
- Pilo 自研 NAT traversal / 公网 Relay。
- Telegram / Discord / 飞书等其他客户端。
- 为 WebUI 复制第二套独立 React 业务实现。
- 为了 Remote 一次性大拆 Rust crates / frontend packages。

## Acceptance Criteria

最终验收标准：

- [ ] 同一 Session 在 Desktop 与 Web 同时打开时，双方看到同一条 Agent streaming 流和最终消息结果。
- [ ] Web 发送 prompt 后，Desktop 无需刷新即可观察到对应 Session 的状态变化和结果；反向同理。
- [ ] Web 断网并恢复后，可以恢复到正确 Session snapshot，不出现永久缺失或重复拼接的消息。
- [ ] Remote 关闭时不启动对外 HTTP/WS listener。
- [ ] Web 无法绕过 Host 直接访问 Local / WSL / SSH Runtime。
- [ ] 未认证请求无法调用任何 Remote API；认证成功设备可以调用第一版 Remote WebUI 暴露的全部 Chat / Session 能力。
- [ ] Mobile 主链路能完成：进入 Pilo → 选择 Project/Session → 查看历史 → 发送消息 → 查看实时结果 → Abort。
- [ ] Web Chat 的消息、Thinking / ToolCall、Composer、Model / Thinking Level、Context 等主要交互与 Desktop 使用同一套组件或同一业务实现，没有功能等价的 Remote 专用副本。
- [ ] Mobile 上的差异主要限定在 Shell / Navigation / responsive styling / touch & viewport adaptation，不改变 Desktop Chat 的核心语义。
- [ ] Mobile 可以从相册/系统图片选择器添加图片并随 Chat 消息发送；不出现通用文件上传入口。
- [ ] Remote 架构引入后，Desktop 的现有 Tauri IPC 路径仍可独立工作，不要求 localhost HTTP。
- [ ] 第一版 Remote Host 生命周期绑定 Desktop 进程：Pilo 桌面进程运行时可远程访问；退出 Pilo 后 Remote listener 与正在运行的 Session 一起停止。

## Deferred Technical Decisions

这些问题会影响设计实现，但不应在产品目标未收敛前提前锁死：

- WebSocket replay buffer 的持久化与窗口大小。
- sequence 是 Host-global、per-session 还是分 topic。
- device token 的具体随机字节长度、哈希格式与存储细节。
- 后续如进入公网阶段，Tailscale / Cloudflare Tunnel 的集成方式。
- 完整 PWA 的 Service Worker / installability 与 Web Push；第一版只做 PWA-ready 基础。
- 是否以及何时支持 Terminal / File write；加入这些能力时再重新评估权限模型。

## Key Decisions

### D1. 第一版 Remote Host 绑定 Desktop 进程

已确认采用 Desktop-coupled Host：

- 只有 Pilo 桌面进程运行时 Remote WebUI 才可访问。
- 退出 Pilo 后 Remote listener 与正在运行的 Session 一起停止。
- 第一版不拆独立 daemon/service，不处理开机启动、独立升级、Host 互斥和 headless 恢复。
- 后续如果 Remote 使用频率证明需要“关闭桌面 UI 后仍继续运行”，再单独评估 tray/background host 或独立 daemon。

### D2. 第一版严格聚焦 Chat / Session Remote Console

已确认第一版范围固定为：

- Connection / Project / Session 导航。
- 历史消息、实时 Agent streaming、Thinking / ToolCall 展示。
- 新建 / 继续 Session。
- Prompt、steer/follow-up、Abort。
- Context / model 等继续对话所需信息。
- 图片附件属于第一版范围，并复用现有 Chat image/attachment contract；不支持通用文件附件。

第一版明确不包含：

- Terminal。
- Desktop 全局快捷键体系；Remote Composer 不启用 Desktop shortcuts。
- 完整 Files / 文件编辑。
- Git GUI。
- Preview。
- Parallel Agent 管理。
- 复杂项目管理。
- 完整 Settings。

### D3. 第一版采用 LAN-first

已确认：

- 第一版只保证同一局域网内的 Remote WebUI 访问。
- Tailscale / Cloudflare Tunnel / reverse proxy 保持协议兼容，但不作为第一版 Pilo 内建能力。
- 不自研公网 Relay / NAT traversal。
- Remote 仍默认关闭；LAN 不视为可信边界，正式访问仍需要设备身份与授权。
- 公网访问、Tunnel Provider 集成、外部 URL/TLS 诊断等作为后续独立阶段。

### D4. 第一版采用 Magic Link / QR 的轻量配对

已确认认证方案以“简单、容易实现”为优先，不引入账号体系或复杂身份系统，也不要求 Desktop 二次确认。

第一版流程：

- Desktop 开启 Remote 后生成一个局域网访问地址，并同时展示对应二维码。
- 地址中包含短时有效、不可预测的一次性 pairing secret；二维码编码同一个地址。
- 手机扫描二维码或直接打开该地址后，自动完成首次配对并进入 WebUI，不再弹出 Desktop 确认步骤。
- 首次配对成功后，Host 为该浏览器/设备签发随机 device token；Web 客户端本地保存 token，后续访问普通 Remote 地址即可自动重连。
- pairing secret 成功使用后立即失效，并设置较短过期时间；Desktop 可主动重新生成新的配对地址/二维码。
- Host 只保存验证所需信息与简单设备元数据，例如设备名、创建时间、最后访问时间、token 到期时间。
- Desktop 提供最小设备列表和“撤销设备”能力。
- HTTP 与 WebSocket 使用同一套 device token 鉴权。
- device token 必须有明确到期时间；过期后该设备需要重新扫码配对，不做 refresh token / 自动续期体系。

Remote 生命周期：

- Desktop 可以随时关闭 Remote/WebUI。
- 关闭后立即停止 HTTP/WS listener，并主动断开所有已连接的 Web 客户端。
- 关闭 Remote 默认不删除已配对设备和未过期 device token；下次重新开启 Remote 后，这些设备仍可直接连接。
- “关闭 Remote”与“撤销设备”是两个独立动作：前者控制当前网络暴露，后者永久使指定 device token 失效。
- Pilo Desktop 退出时等价于关闭 Remote；因为第一版 Host 生命周期绑定 Desktop 进程。

安全边界：

- 不能让裸 LAN 地址本身等同于授权；否则同一局域网内任何能访问端口的人都可直接控制 Pilo。
- QR / 带 secret 的地址在有效期内等同于临时授权凭据，因此只在用户主动打开 Remote 配对界面时展示。
- 第一版不增加二次确认，以一次性、高熵、短时有效 secret 换取更简单的交互和实现。
- token 到期后必须拒绝新的 HTTP 请求，并终止使用该 token 的 WebSocket 会话。

第一版明确不做：

- 用户账号 / 登录注册。
- OAuth / 第三方登录。
- 云端身份或设备同步。
- 公私钥设备证书体系。
- token rotation / refresh token 等复杂生命周期。
- 角色系统和复杂的逐设备 capability 配置界面。

### D5. 第一版 device token 固定 30 天过期

已确认：

- Pairing Magic Link 默认 5 分钟过期，并且成功使用一次后立即失效。
- Device token 固定 30 天绝对过期。
- token 到期后重新扫描 Desktop 上的新二维码即可。
- Desktop 仍可在到期前手动撤销设备。
- 不做 refresh token。
- 不做“每次使用自动延长”的滑动过期。

### D6. 认证成功后拥有 Remote WebUI 全部权限

已确认第一版不考虑权限分级：

- 认证成功的设备可以使用第一版 Remote WebUI 暴露的全部能力。
- 不设计 capability、role、只读模式或逐设备权限配置。
- API 只区分“未认证”和“已认证”，不做 session.read / session.write / session.abort 等权限 guard。
- 第一版未暴露的 Terminal、Files、Git 等能力自然不可远程调用。
- 如果未来把 Terminal / Files 等更高风险能力加入 Remote，再单独重新评估是否需要权限模型。

### D7. Remote 开关状态持久化

已确认：

- 新安装默认 Remote = OFF。
- 用户手动开启 Remote 后持久化该状态。
- Pilo 下次启动时自动恢复 Remote listener。
- 未过期且未撤销的已认证设备可以直接访问。
- 用户手动关闭 Remote 后持久化为 OFF；下次启动保持关闭。
- Remote 开关属于 Host 运行配置，技术上应由 Rust/Host 侧持久化，而不是依赖前端 localStorage 才恢复。

### D8. WebUI 对齐 Desktop Chat + Mobile-adapted + PWA-ready

已确认：

- WebUI 绝大部分时间用于手机，但产品体验以现有 Desktop Chat 为基准，不另外发明一套 Remote/Mobile Chat。
- 优先复用现有 ChatConversationViewport、Message / Thinking / ToolCall rendering、Composer、Context、Model / Thinking Level、Pending Queue 等 Desktop 能力；需要移动适配时优先扩展共享组件。
- Mobile 单独适配 app shell、Project / Session navigation、safe area、软键盘、触控目标、窄屏布局与前后台恢复。
- Desktop Sidebar 不要求直接塞进手机；可以做轻量 Drawer / Sheet，但其职责仍只是导航到同一套 Chat 主视图。
- 增加 Web App Manifest、图标、theme color、standalone-friendly 页面结构等 PWA-ready 基础。
- 第一版不把 service worker、offline cache、installability、Web Push 作为验收要求。
- WebPiloClient、认证与 reconnect 不依赖 Service Worker。
- 后续具备 HTTPS（Tunnel / reverse proxy 等）后，可以直接补齐完整 PWA 能力，而无需重构 WebUI。
- Desktop Browser 第一版只要求功能可用和基本响应式。

### D9. 第一版只支持图片附件

已确认：

- 图片附件属于第一版范围，支持从手机相册选择图片；如果浏览器/系统文件选择器提供拍照入口，可直接复用。
- 图片沿用现有 Chat image/attachment contract，不为 Web 单独设计第二套语义。
- 第一版不支持通用文件附件，例如 PDF、文本文件、压缩包等。
- 不为第一版引入通用文件上传、MIME 管理、临时文件生命周期或 Remote 文件传输体系。
- 如果现有图片 contract 复用成本高于预期，可以把图片实现拆成紧随 Chat 主链路之后的小阶段，但 Web API / PiloClient contract 需要预留图片能力。

### D10. 后端采用单进程模块化单体 + Ports & Adapters

已确认：

- Pilo Desktop 进程仍是唯一 Host，不增加第二个后端进程。
- 在 src-tauri 内增加 Application Service 层，承载 Remote MVP 的 Project / Session / Chat use case。
- Tauri command 与 Remote HTTP/WebSocket handler 都是薄 Adapter，并调用同一 Application Service。
- Application Service 不依赖 Tauri command / HTTP 类型，并逐步去除 Remote MVP 链路里的 AppHandle 依赖。
- 现有 runtime 继续持有 ChatSessions、ServerManager、Pi process 等运行时对象，不为了 Remote 重写。
- 现有 storage 继续使用 SQLite，但把 app_data_dir / DB path 等平台路径解析抽成 HostPaths / StorageContext。
- RuntimeEventBus 演进为多订阅 EventHub，Desktop Tauri Channel 与 WebSocket 都只是 subscriber。
- 第一版只抽 Chat / Project / Session 相关链路；Terminal / Preview / Parallel 等未进入 Remote MVP 的模块继续保持 Tauri-only。
- Remote Web Server 与 Tauri 共用同一个 Tokio runtime / 进程生命周期。
- Web Adapter 采用 Axum + Tower/Tower-HTTP，负责 routing、auth、DTO、HTTP error mapping、WebSocket upgrade 与 static WebUI serving。
- 第一版不新建 pilo-core / pilo-host crate，只新增 Rust module；未来确实需要 daemon/headless host 时再抽 crate。

逻辑依赖方向：

Tauri Adapter / Web Adapter -> Application Services -> Runtime + Storage

Runtime Events -> EventHub -> Tauri Subscriber / WebSocket Subscriber

不允许 Web handler 直接调用 Tauri command，也不允许 Tauri command 和 HTTP handler 各复制一份业务流程。

## Blocking Open Questions

无。
