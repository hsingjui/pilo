# Remote Web 韧性与 PWA 体验优化

## Goal

让 Pilo Remote Web 在普通手机浏览器和已安装 PWA 中都具备更稳定的启动、断网恢复、前后台恢复和版本更新体验，同时保持 Remote Host 仍是唯一权威数据源，并确保 Tauri Desktop WebView 不注册 Service Worker、不改变现有 Desktop 行为。

本任务解决的是 **Remote Web 的浏览器韧性**，PWA 只是其中一个呈现形态；除 Service Worker / 安装态能力外，网络状态与恢复逻辑必须同时作用于普通浏览器。

## User Value

- 手机切换 Wi-Fi、锁屏、切到其他 App 再回来时，不需要等待最长 30 秒 backoff 或手动刷新才能继续。
- Remote Host 暂时不可达时，页面能保留应用壳和明确状态，而不是直接落到浏览器错误页（仅在浏览器允许 Service Worker 的安全上下文中）。
- 新版本可被发现，但不会在 Agent 正在运行时自动刷新并打断当前会话。
- 普通浏览器和安装后的 PWA 共享同一套连接恢复逻辑，不产生两套实现。

## Confirmed Facts

- Desktop / Browser 入口已经在 `src/main.tsx:16-17` 通过 `__TAURI_INTERNALS__` 区分；Browser 分支只动态加载 `RemoteApp`（`src/main.tsx:158-177`）。因此可以把 Service Worker 注册严格放在 Remote Browser 路径，不让 Desktop WebView 参与。
- 当前 Remote WebSocket 已有断线探测、认证 probe 和 1.5s -> 30s capped exponential backoff（`src/remote/use-remote-connection.ts:104-180`），但没有 `online/offline` 监听，也没有浏览器前后台恢复专用路径。
- Remote UI 当前只展示 connected / reconnecting 两态（`src/remote/remote-app.tsx:282-293`），无法明确表达“设备离线”与“网络在线但 Host 不可达”的差异。
- Remote Session bootstrap / session index 已能重拉 authoritative state（`src/remote/use-remote-sessions.ts:44-106`），可作为恢复后的 snapshot reconciliation 基础。
- Remote 静态资源服务对 `index.html` / SPA fallback 使用 `no-cache`，对 fingerprinted assets 使用一年 immutable cache（`src-tauri/src/runtime/remote/api/mod.rs:167-172`），适合在浏览器层增加 App Shell 缓存而不修改 API 权威性。
- 默认 LAN 地址仍是 `http://<LAN-IP>:<port>`（`src-tauri/src/runtime/remote/manager.rs:278`）。Service Worker 受浏览器 secure-context 限制，因此 **不能成为 Remote Web 基础连接能力的依赖**；普通 LAN HTTP 必须在没有 Service Worker 时仍完整工作。
- 原 Remote WebUI 任务明确把 Service Worker / offline cache / Web Push 延后（`.trellis/tasks/09-23-remote-webui-requirements/prd.md:174`、`design.md:96`）；本任务只承接其中的 Service Worker / offline shell 部分，不扩大到 Web Push。

## Requirements

### R1. Remote Browser Only Boundary

- Service Worker 注册、更新检测与 Cache Storage 逻辑只允许存在于 Browser / Remote 路径。
- Tauri Desktop WebView 不注册 Service Worker，不创建 Remote Web cache，不受 update lifecycle 影响。
- Service Worker 不得成为认证、WebSocket、Session 恢复或普通 LAN HTTP 可用性的前置条件。
- 当 `navigator.serviceWorker` 不可用或当前 origin 不是 secure context 时，静默降级到当前网络加载方式；其余网络恢复优化仍生效。

### R2. App Shell Cache

在 Service Worker 可用时：

- 预缓存版本化 App Shell：`index.html`、构建生成的 hashed JS/CSS/font assets、manifest 和 PWA icons。
- 不手写 hashed asset 文件名；缓存清单必须由构建产物生成。
- Navigation 可在 Host 暂时不可达时回退到已缓存的 App Shell。
- `/api/v1/**` 必须始终 Network Only，不允许把 bootstrap、history、model、auth、图片、Session 状态等业务响应写入 Cache Storage。
- WebSocket 不经过 Service Worker，不改变现有 replay / sequence / resync contract。
- pairing URL 中的 `?pair=...` 不得作为独立 navigation cache key 持久化，避免一次性 secret 出现在 Cache Storage。
- 新 Service Worker 激活后清理旧版本 App Shell cache。

### R3. Network Lifecycle and Immediate Recovery

- 增加 `navigator.onLine` + `online/offline` 监听；它只作为设备网络提示，不能代替 HTTP / WebSocket 的真实连接状态。
- 浏览器明确 offline 时：
  - UI 进入 offline 状态；
  - 不继续无意义地按 backoff 高频重建 WebSocket；
  - 保留当前已渲染会话与 composer 内容。
- `online` 触发时：
  - 立即取消/绕过当前 backoff；
  - 立即重建 WebSocket；
  - 触发一次 authenticated bootstrap / snapshot reconciliation；
  - 不需要等待原本最长 30 秒的 reconnect timer。
- 页面从 hidden/background 回到 visible 时，执行一次有界的 resume 流程，确认 Host / WebSocket 可用并恢复 authoritative state；不能只相信后台挂起前的 `connected=true`。
- 恢复继续使用现有 sequence replay；发生 replay gap 时仍走现有 resync / snapshot 路径，不新增第二套消息恢复机制。
- 所有 listener / timer 在 hook cleanup 时释放，避免 StrictMode 下重复订阅。

### R4. Connection State UX

Remote Web 至少区分：

1. `connected`：Host + WebSocket 可用。
2. `offline`：浏览器报告设备当前无网络。
3. `reconnecting`：设备在线，但 Remote Host / WebSocket 尚未恢复。
4. 现有 auth expired / pairing required 继续走现有 fatal/auth UI，不并入网络状态。

要求：

- Desktop Browser sidebar footer 与 Mobile Navigation 使用同一状态来源。
- Composer 附近的 recovery notice 与全局连接状态语义一致，不出现“设备离线但显示正在连接成功”之类冲突。
- 新文案通过现有 zh-CN / en-US i18n 资源提供。

### R5. Safe Web App Updates

仅在 Service Worker 可用时：

- 检测到 waiting/new worker 后记录 `updateAvailable`，**不得自动 `skipWaiting + reload`**。
- Agent / 当前 turn 正在运行时，不弹出会导致误操作的强制刷新 UI；更新提示延后到可安全交互状态。
- 空闲时显示轻量、非模态的“新版本可用”提示，由用户主动点击“更新”。
- 用户确认更新后再激活 waiting worker，并在新 worker 接管后刷新页面。
- 用户忽略更新时，当前版本继续工作，不影响发送消息或 reconnect。

### R6. Non-regression / Compatibility

- 普通 Browser 和已安装 PWA 共用同一套 Remote connection lifecycle。
- 现有 pairing token、30 天 device token、WebSocket auth probe、sequence replay、resyncRequired 语义保持不变。
- 不把 Remote API 变成 offline-first 数据源；Host 始终是 Project / Session / Chat 状态权威。
- 不要求给当前 LAN listener 内建 HTTPS；HTTPS / reverse proxy / tunnel 仍是独立部署能力。
- 如果 Service Worker 构建工具与当前 Vite 8 不兼容，允许换成等价的 Vite 构建期 manifest 注入方案，但不能退化为手工维护 hashed asset 列表。

## Acceptance Criteria

- [ ] 在普通 Browser 和安装后的 PWA 中，`offline -> online` 后都能立即触发 reconnect + bootstrap/resync，不等待旧 backoff 最长 30 秒。
- [ ] 浏览器 offline 时不持续创建无意义的 reconnect timer；当前页面、已加载消息与未发送 composer 内容仍保留。
- [ ] 页面在后台停留后恢复前台时，会重新验证连接并最终回到 authoritative Session 状态；active turn 能通过现有 replay/resync 继续显示。
- [ ] UI 能稳定区分 connected / offline / reconnecting，并在 Desktop Browser sidebar 与 Mobile Navigation 中一致呈现。
- [ ] Tauri Desktop 启动后没有 Service Worker registration / Cache Storage 副作用，Desktop 行为不变。
- [ ] 在支持 Service Worker 的 secure origin 上，完成至少一次在线加载后，Host 暂时不可达时重新打开/刷新 Remote Web 仍能加载 App Shell，并显示 offline/reconnecting 状态，而不是浏览器网络错误页。
- [ ] `/api/v1/**` 不出现在 Service Worker runtime cache；pairing secret URL 不被写入 navigation cache。
- [ ] 检测到新 Web 版本时不会自动 reload；active turn 运行期间不会被更新流程打断；空闲后用户可主动应用更新。
- [ ] 普通 LAN HTTP（Service Worker 不可用）仍可正常配对、聊天、断线重连和前后台恢复，没有功能降级到不可用。
- [ ] 前端修改通过 `pnpm format`、`pnpm check`、`pnpm build`、相关 `pnpm test:unit`；若修改 Rust 静态资源服务，再补跑对应 Cargo tests。

## Out of Scope

- Web Push / 后台完成通知。
- Background Sync / 离线发送队列。
- 缓存 Chat history、bootstrap、models、附件或任意 `/api/v1/**` 数据。
- Share Target、安装引导 Banner、manifest screenshots。
- 为 LAN listener 内建 TLS、证书签发或自动 HTTPS。
- 独立 daemon / tray Host 生命周期调整。
- 修改 Desktop Chat 的连接生命周期。
- 新增 WebSocket application heartbeat 协议；本任务优先复用已有 reconnect + snapshot/replay 能力。

## Key Decisions

- **D1：Remote Web 能力优先，PWA 能力渐进增强。** online/offline、foreground resume、立即重连对所有 Browser 生效；Service Worker / update UI 只在浏览器实际支持时启用。
- **D2：只缓存 App Shell，不缓存业务数据。** 离线时可以打开 UI，但不能伪装成“离线 Chat 可用”；所有会话状态继续以 Host 为权威。
- **D3：更新必须由用户确认。** 不自动 reload，不用版本更新打断 active turn。
- **D4：不为 Service Worker 引入 LAN HTTPS 依赖。** 默认 LAN HTTP 的基础 Remote 体验仍是完整的一等路径。
- **D5：复用现有 replay/resync。** foreground / online recovery 只负责尽快重新建立 transport 和 snapshot，不创建新的消息恢复状态机。

## Risks / Deferred Items

- Service Worker 在默认 `http://<LAN-IP>` 下通常不可用；离线 App Shell 与 SW 更新提示只保证在 secure origin / 浏览器实际暴露 `navigator.serviceWorker` 时启用。若未来要求“默认 LAN IP 也必须离线启动”，需要单独评估 TLS。
- Service Worker 构建集成应使用自动生成的 precache manifest。具体采用 `vite-plugin-pwa` / Workbox `injectManifest` 还是等价 Vite 构建 hook，在实现前先验证与当前 Vite 8 的兼容性；该工具选择不得改变上述行为契约。
- foreground resume 的防抖/后台时长阈值属于实现调优项，可在移动端实际测试后调整，不改变“恢复前台必须重新验证连接”的验收语义。
