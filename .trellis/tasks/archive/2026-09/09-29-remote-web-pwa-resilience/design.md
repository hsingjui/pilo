# Remote Web 韧性与 PWA 体验优化 — Design

## Architecture Boundary

保持现有入口边界：

```text
src/main.tsx
├─ Tauri Desktop -> App
└─ Browser        -> RemoteApp
                      ├─ network lifecycle
                      ├─ remote connection
                      └─ optional PWA runtime
```

Service Worker 注册必须从 Browser / Remote 分支触发，不能放到 Desktop 也会执行的全局初始化路径。即使构建产物中包含 `sw.js`，Tauri WebView 也不会注册它。

## 1. Browser Network State

新增一个 Remote-local hook（命名可按实现调整，例如 `use-remote-network-lifecycle.ts`），集中拥有：

- `navigator.onLine` 初始值。
- `online` / `offline` listener。
- `visibilitychange` resume listener。
- offline 时暂停 retry、online 时 immediate reconnect 的协调。
- cleanup。

不要把这些监听散落到 `RemoteApp`、`useRemoteConnection` 和导航组件三处。

建议暴露：

```ts
type RemoteNetworkState = "connected" | "offline" | "reconnecting";

{
  networkState,
  browserOnline,
  resumeGeneration,
}
```

真正的 connected 仍来自 WebSocket 状态；`navigator.onLine` 只覆盖明确 offline 情况。

## 2. Reconnect Coordination

现有 `useRemoteConnection` 保留 WebSocket、sequence 和 backoff 所有权。

扩展点：

- offline 时禁止安排下一轮 reconnect timer。
- online 时调用现有 `reconnectNow()`，清零 attempt 并立即 bump reconnect generation。
- foreground resume 复用同一个 immediate reconnect 入口，避免新增第二套 socket 生命周期。
- reconnect 成功后触发一次 bootstrap/snapshot reconciliation；现有 `resyncKey` / `reloadBootstrap` 能力应复用。
- 现有 auth probe 保留：浏览器 WS 1006 无法区分 expired token，因此仍需要 authenticated HTTP probe。

foreground 策略：

- 记录页面进入 hidden 的时间。
- visible 时如果此前存在 background/suspend 窗口，执行一次 immediate transport validation。
- 可以用一个小阈值避免桌面浏览器极短 tab 切换造成 socket 抖动；阈值作为单一常量，不进入持久化配置。
- 无论采用“直接重建 socket”还是“probe 后重建”，最终必须覆盖 stale-open socket 场景。

## 3. Connection Presentation State

在 Remote connection/lifecycle 层计算一次：

```text
browser offline                -> offline
browser online + ws connected  -> connected
browser online + ws down       -> reconnecting
auth invalid                   -> existing auth/fatal path
```

Desktop Browser sidebar footer、Mobile Navigation、composer recovery notice 都消费这个状态，不各自重新推导。

不新增全屏 offline 页面；保留当前会话 UI，让用户能看到历史内容与未发送输入。

## 4. Service Worker Build Model

### Progressive Enhancement Gate

注册条件至少包含：

```ts
!DESKTOP_RUNTIME &&
import.meta.env.PROD &&
window.isSecureContext &&
"serviceWorker" in navigator
```

因为 RemoteApp 本身只在 Browser 分支加载，实际实现可以把 guard 封装在 Remote PWA hook 中。

### Precache

必须由构建阶段生成 precache manifest，包含：

- `index.html`
- hashed JS / CSS
- fonts
- manifest
- PWA icons

禁止在源码里硬编码 `assets/index-xxxx.js` 之类产物名。

优先采用支持当前 Vite 版本的 `injectManifest` 类方案，让项目保留自定义 fetch/update 策略；若第三方插件兼容性不满足，则用等价 Vite build hook 注入产物列表。

### Fetch Policy

```text
/api/v1/**              -> NetworkOnly
WebSocket               -> browser native, SW 不介入
navigation              -> cached app-shell fallback
hashed static assets    -> precache
manifest/icons          -> precache
other requests          -> network / existing browser cache
```

Navigation 不缓存原始 request URL，尤其不能把 `/?pair=<secret>` 作为独立 cache key。离线 fallback 应统一返回 precached `index.html`。

## 5. Update Lifecycle

Service Worker 不自动 `skipWaiting`。

Remote PWA hook 持有：

```ts
{
  updateAvailable: boolean;
  applyUpdate(): Promise<void>;
}
```

流程：

1. 浏览器发现 waiting worker。
2. 记录 `updateAvailable`。
3. active turn 存在时只保留状态，不触发 reload UI。
4. turn idle 后显示持久但非模态提示。
5. 用户点击更新。
6. 通知 waiting worker activate。
7. `controllerchange` 后执行一次 `window.location.reload()`。

如果用户不点击，旧页面继续运行。

## 6. UI Placement

- Desktop Browser：复用 sidebar footer 的连接状态位置。
- Mobile：复用 `RemoteMobileNavigation` 底部连接状态。
- Composer：继续使用 `ChatRuntimeRecoveryNotice` 表示会话 transport recovery；需要时只扩展 message key，不复制第二个 notice。
- 更新提示优先用现有全局 Toaster / Sonner action，若持续 toast 在移动端体验不稳定，再做 Remote-local 小型 banner；不要新增 Dialog。

所有新文案进入 `src/i18n/resources/en-US.ts` 与 `zh-CN.ts`。

## 7. Compatibility

### Tauri

- Desktop 不调用 `navigator.serviceWorker.register`。
- Desktop 不等待 SW ready。
- Desktop update plugin 与 Web SW update 完全独立。

### Plain LAN HTTP

默认 `http://LAN-IP` 可能没有 Service Worker：

- 不报错。
- 不展示“更新不可用”等无意义 UI。
- online/offline、immediate reconnect、foreground resume 全部仍工作。

### HTTPS / Secure Origin

在反向代理、Tunnel 或其他 HTTPS 访问下：

- SW 注册并获得 App Shell offline fallback。
- update lifecycle 生效。

## 8. Rollback Points

实现建议拆成独立提交：

1. network lifecycle + reconnect（不含 SW）。
2. connection status UI / i18n。
3. SW build + cache policy。
4. update lifecycle。

如果 SW 出现兼容问题，可以只撤回 3/4，保留对普通 Browser 同样有价值的 1/2。
