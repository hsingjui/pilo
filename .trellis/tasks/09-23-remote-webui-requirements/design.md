# Remote WebUI Design

## Architecture

第一版继续采用 Desktop-coupled Host：Desktop React 走 Tauri IPC/Event，Mobile Web 走 HTTP/WebSocket，两者最终进入同一个 Pilo Host / Application Services，再进入 Local / WSL / SSH / Pi Runtime。

- Desktop 不迁移到 localhost HTTP。
- Web Adapter 只是新的 transport adapter。
- Session 仍由 Host 持有，Desktop/Web 都只是 observer/controller。

## Host Lifecycle

- Remote 默认关闭。
- Remote 开关由 Rust Host 侧持久化。
- 开启时启动 LAN listener；关闭时立即停止 listener 并断开全部 WebSocket。
- Pilo Desktop 退出时停止 Remote。
- 重启后若持久化状态为开启，则自动恢复 Remote listener。
- 第一版不拆 daemon/service。

## Authentication

采用 Magic Link / QR 轻量认证：

1. Desktop 开启 Remote。
2. Host 生成 5 分钟有效、一次性 pairing secret。
3. Desktop 显示普通 LAN 地址和含 pairing secret 的 Magic Link / QR。
4. 浏览器首次打开 Magic Link 后完成认证并换取随机 device token。
5. pairing secret 立即失效。
6. device token 固定 30 天绝对过期，Web 本地保存。
7. 后续访问普通 Remote 地址时通过 device token 自动认证。
8. Desktop 可撤销 device token。

第一版只有 authenticated / unauthenticated 两种状态，不设计 capability 或 role。Token 持久化优先保存 hash 而不是明文。

## Remote Data Model

Host 侧至少需要 remote_enabled，以及 paired devices 的 device_id、display_name、token_hash、created_at、last_seen_at、expires_at、revoked_at；还需要当前 pairing secret 的 hash、expires_at、consumed state。持久化优先使用现有 SQLite，而不是前端 localStorage。

## HTTP / WebSocket Boundary

HTTP 负责 bootstrap/health、pairing exchange、connections/projects/sessions query、session history/snapshot、create/open session、prompt/steer/follow-up、abort、context/model 等 MVP command/query。

WebSocket 负责 runtime/session events、streaming text/thinking/tool events、session/project update signals 和 reconnect lifecycle。

第一版不暴露 Terminal、Files、Git、Preview、Parallel Agent API。附件仅支持 Chat 图片，复用现有 image/attachment contract，不提供通用文件上传 API。

## Event Architecture

现有 RuntimeEvent / RuntimeEventEnvelope 继续作为底层 runtime event contract，但 RuntimeEventBus 必须从单 Tauri Channel 演进为多订阅模型：Desktop subscriber 与 Web subscriber(s) 可以同时存在。

- slow/disconnected Web client 不得阻塞 Runtime。
- 高频 delta 允许在 Web Adapter 层 batch/coalesce。
- Web 事件增加恢复所需 sequence。
- 首次连接先取 authoritative snapshot，再订阅事件。
- 短断线允许 replay；gap 超出窗口时重新拉 snapshot。

sequence 粒度可在实现阶段选择 per-session 或 Host-global，只要协议稳定并能可靠恢复。

## Session Command Semantics

- Remote 不重新发明 Chat 状态机。
- Session 仍由 Host 的 ChatSessions 持有。
- Web command 必须显式带 session identity。
- 空闲 Session 普通发送走 prompt。
- busy Session 继续复用现有 Pi steer / follow-up / abort 语义。
- Desktop 与 Web 同时操作时，以 Host/Pi 的实际 queue/runtime state 为权威。
- 第一版不解决 presence、协作编辑或多用户冲突提示。

## Frontend Boundary

逐步形成 transport-neutral PiloClient，至少包含 connections、projects、sessions、events 四个域。

- TauriPiloClient -> invoke / Tauri channel。
- WebPiloClient -> fetch / WebSocket。
- 优先复用 conversation types/reducer、message/thinking/tool-call rendering、composer business rules、context/model UI。
- Desktop layout/sidebar、Mobile layout/navigation、Remote bootstrap/auth screen 可以独立实现。
- 不复制第二套业务状态机。

## Mobile-first / PWA-ready UX

WebUI 的第一优先设备是手机。

- 主视图为 Header / current session + Chat + Composer。
- Project / Session 使用 Drawer / Sheet 或独立移动页面。
- 优先处理 safe area、软键盘、触控目标、单手操作和浏览器前后台切换。
- 未认证时提示在桌面 Pilo 中打开 Remote 并扫描二维码。
- token expired/revoked 时清除本地 token 并回到未认证页。
- Remote 被桌面关闭时进入明确 disconnected/offline 状态。
- 第一版提供 Web App Manifest、icons、theme color 与 standalone-friendly app shell。
- 第一版不要求 Service Worker、offline cache、installability 或 Web Push；这些能力不得成为认证、reconnect 或基础导航的依赖。
- Desktop Browser 只保证功能可用和基本响应式，不复刻 Tauri Desktop 布局。

## Desktop Settings UX

第一版只需要 Remote 开关、LAN URL、QR / Magic Link、重新生成配对链接、已认证设备列表、token 到期时间、撤销设备。

## Security Notes

- LAN 不视为可信。
- listener 只在 Remote enabled 时存在。
- pairing secret 高熵、短时、一次性。
- device token 高熵、30 天固定过期。
- HTTP 与 WebSocket 共用认证验证。
- expired/revoked token 立即失效。
- secret/token 不进入普通日志。
- API 只暴露 MVP 能力，不提供任意 command proxy。

## Compatibility

- Desktop 保持 Tauri IPC，不依赖 Remote Server。
- Remote disabled 时不启动 HTTP/WS。
- Local / WSL / SSH Runtime 路径不变。
- Phase 1 解耦不得改变现有 Desktop 可观察行为。

## Risks

- RuntimeEventBus 当前只有单 subscriber，改造时要避免 streaming 性能回归。
- 部分 queue/turn 表现状态仍在 React hooks 中；Remote API 不能依赖某个 Desktop hook 才能正确工作。
- 手机浏览器后台挂起使 snapshot reconciliation 成为 MVP 必需能力。
- LAN IP 变化第一版通过重新查看 Desktop Remote 设置解决，不额外引入 mDNS/relay。

## Proposed Backend Architecture

### Style

推荐采用单进程 modular monolith + Ports & Adapters。第一版所有后端仍运行在 Pilo Desktop/Tauri 进程内，不新增 daemon，也不提前拆 pilo-core crate。

逻辑分层：

1. Domain：现有 domain types 与纯业务值对象。
2. Application：新增 transport-neutral use cases/services，仅覆盖 Remote MVP 所需的 Connection/Project/Session/Chat。
3. Runtime/Infrastructure：复用现有 ChatSessions、ServerManager、Pi runtime、SQLite storage。
4. Adapters：
   - Tauri commands：Desktop transport adapter。
   - Remote Axum：HTTP/WebSocket transport adapter。
5. Platform：Tauri-specific 路径解析、窗口/通知等平台能力；Remote MVP 的 Application 层不直接依赖这些类型。

依赖方向必须是 Adapter -> Application -> Runtime/Storage，不能反向。

### Suggested Physical Layout

不要求第一版大规模移动现有文件；先建立清晰的新边界：

- src-tauri/src/application/
  - chat.rs
  - sessions.rs
  - projects.rs
  - remote.rs
- src-tauri/src/remote/
  - server.rs
  - router.rs
  - auth.rs
  - ws.rs
  - dto.rs
  - assets.rs
- src-tauri/src/runtime/
  - 保留现有 process/server/session managers
- src-tauri/src/runtime/commands/
  - 暂时继续作为 Tauri adapter，逐步变薄

后续若边界稳定，再决定是否物理移动 storage/commands；不要为了目录整洁先做大迁移。

### Host Context

Remote MVP 链路逐步以显式 Host context 替代 AppHandle：

- HostPaths：至少包含 app_data_dir / DB path / Pi workspace anchor root。
- Shared runtime handles：ChatSessions、ServerManager 等。
- EventHub：transport-neutral runtime event publisher/subscriber。
- RemoteServerManager：负责 listener task 生命周期。
- RemoteAuthRepository：负责 pairing/device token 持久化。

Tauri setup 负责把 Tauri AppHandle 转换为 HostPaths 和平台 adapter；Application Service 本身不接收 AppHandle。

### Application Services

第一版不要做一个巨大的 God Service。按 use case 域拆轻量 service：

- ProjectService：list/get/touch 与 Remote 需要的 project query。
- SessionService：list/history/reconcile/create/open。
- ChatService：prepare/start/state/send prompt/steer/follow-up/abort。
- RemoteService：Remote 开关、pairing、device list/revoke。

Service 返回 domain/DTO-friendly result，不返回 Tauri types 或 HTTP responses。

### Tauri Adapter

现有 #[tauri::command] 最终应只做：

- 参数反序列化。
- 调用 Application Service。
- 将 domain/application error 映射为当前 Desktop 可接受的 command error。

Remote MVP 相关 command 中现有的 project lookup、runtime profile resolve、external owner check、chat session orchestration 应下沉到 Application Service；不能让 Axum 再复制一遍。

### Web Adapter

推荐 Axum + Tower/Tower-HTTP：

- Axum Router：/api/v1/* 与 WebSocket endpoint。
- middleware：auth、request id、basic timeout/body limit、logging。
- handler：解析 DTO -> 调 service -> map response。
- static asset fallback：Mobile WebUI。
- WebSocket adapter：订阅 EventHub，并实现 sequence/replay/reconciliation protocol。

Axum 只是一层 adapter，不拥有 Pilo Session 状态。

### EventHub

现有 RuntimeEvent/RuntimeEventEnvelope 保留为底层事件模型。

RuntimeEventBus 升级为多 subscriber EventHub：

- publish 不等待 Web client。
- 每个 subscriber 有 bounded queue。
- Desktop Tauri channel 是一个 subscriber。
- 每个 WebSocket connection 是一个 subscriber。
- replay buffer/sequence 作为 EventHub 或 Web event layer 的附加能力，不塞进 Pi runtime。
- subscriber lag 时优先触发 resync，而不是反压 Agent streaming。

### Storage

第一版继续使用现有 SQLite，避免引入第二种数据库。

需要做的解耦：

- storage::open 不再要求业务层持有 AppHandle，而是接受 DB path/HostPaths。
- Remote config、paired devices、token metadata 放同一 SQLite。
- Runtime process state 不持久化到 DB；仍以内存 Runtime 为权威。
- Remote WebUI 关闭/重启只影响 listener，不创造第二套 Session state。

### Remote Server Lifecycle

RemoteServerManager 由 Host 持有：

- start(bind config)
- stop()
- state()
- shutdown()

Server task 与 Desktop 进程共用 Tokio runtime。
Remote OFF 时不存在 listener。
Desktop Exit 时先 stop Remote Server，再按现有流程停止 chat sessions / watchers / terminals / server clients。

### Migration Scope

第一版只去除 Remote MVP 链路中的 Tauri coupling：

- storage/path access
- chat session event sink
- Project/Session/Chat Application use cases

Terminal、Preview、Parallel Agent、native picker、desktop notification 等保持现状，直到它们真的需要远程化。

### Future Extraction

如果未来确认需要 background daemon/headless host，再将已经不依赖 Tauri 的 application/runtime/storage boundary 抽成 pilo-core 或 pilo-host crate。

不要现在为了“未来可能需要”先做 crate 拆分。
