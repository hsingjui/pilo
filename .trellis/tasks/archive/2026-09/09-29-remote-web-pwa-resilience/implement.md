# Remote Web 韧性与 PWA 体验优化 — Implementation Plan

## Phase 1 — Network Lifecycle

- [ ] 新建 Remote-local network lifecycle hook，集中管理 `online/offline/visibilitychange`。
- [ ] 扩展 `useRemoteConnection`：offline 时暂停 reconnect timer，online 时 immediate reconnect。
- [ ] foreground resume 时验证/重建 transport，并触发 authoritative bootstrap/resync。
- [ ] 保留现有 auth-expiry HTTP probe 与 sequence replay/resync 语义。
- [ ] 抽出可纯测的 connection presentation state / lifecycle helper（若逻辑达到非平凡程度），并加入 Node unit test。

重点文件：

- `src/remote/use-remote-connection.ts`
- `src/remote/remote-app.tsx`
- `src/remote/use-remote-sessions.ts`
- 新的 `src/remote/use-remote-network-lifecycle.ts`（或等价命名）
- 必要时新的纯函数 helper + `tests/*.test.ts`

## Phase 2 — Connection UX

- [ ] connection state 增加 connected / offline / reconnecting。
- [ ] Desktop Browser sidebar footer 与 Mobile Navigation 统一消费该状态。
- [ ] recovery notice 与 network state 对齐，避免重复或矛盾提示。
- [ ] 增加 zh-CN / en-US 文案。
- [ ] 保证 offline 时会话内容与 composer 不被清空。

重点文件：

- `src/remote/remote-app.tsx`
- `src/remote/remote-mobile-navigation.tsx`
- `src/components/chat/chat-runtime-recovery-notice.tsx`（仅在确实需要共享扩展时修改）
- `src/i18n/resources/en-US.ts`
- `src/i18n/resources/zh-CN.ts`

## Phase 3 — Service Worker / App Shell

- [ ] 先验证当前 Vite 8 与候选 SW/precache 构建方案兼容性。
- [ ] 使用构建生成的 precache manifest，不硬编码 hashed filenames。
- [ ] Service Worker 仅从 Remote Browser 入口注册，并加 production + secure-context + capability guard。
- [ ] precache `index.html`、hashed assets、fonts、manifest、icons。
- [ ] navigation 使用统一 cached app-shell fallback，不能持久化带 `pair` query 的 URL。
- [ ] 明确 `/api/v1/**` NetworkOnly。
- [ ] 清理旧版本 caches。
- [ ] 检查生成的 `dist` 中 SW / precache 内容；确认 API path 未进入缓存规则。

可能涉及：

- `vite.config.ts`
- 新的 Remote SW 源文件 / PWA registration hook
- `package.json` / lockfile（仅当采用构建插件）

## Phase 4 — Safe Update Flow

- [ ] 捕获 waiting worker / update available。
- [ ] active turn 期间延迟展示更新操作。
- [ ] idle 时提供轻量“新版本可用 / 更新” action。
- [ ] 用户点击后才 activate waiting worker。
- [ ] `controllerchange` 后 reload；不自动 reload。
- [ ] unsupported / insecure origin 下不展示 SW update UI。

## Validation

### Automated

```bash
pnpm format
pnpm check
pnpm build
pnpm test:unit
```

如果修改 `src-tauri/src/runtime/remote/api/mod.rs` 或 static serving：

```bash
cargo test --manifest-path src-tauri/Cargo.toml runtime::remote::api
```

同时检查：

- `dist` 中存在期望的 SW / precache 产物。
- precache 不含 `/api/v1/**`。
- pairing query 不作为 cache entry。
- Desktop bundle/browser path 仍保持动态分流。

### Manual Browser Matrix

1. **普通 Browser / online**
   - 配对、打开 Session、发送消息、streaming 正常。
2. **offline -> online**
   - 断 Wi-Fi/网络后显示 offline。
   - 恢复网络后立即 reconnect，不等待旧 30s timer。
3. **background -> foreground**
   - 手机切后台一段时间再回来。
   - 能恢复 WebSocket 与 active turn，不重复/丢失消息。
4. **Host unavailable**
   - 设备网络仍在线但 Pilo Host 停止：显示 reconnecting，不误报 offline。
5. **plain LAN HTTP**
   - 无 SW 时以上连接生命周期仍全部可用。
6. **secure origin / SW**
   - 在线加载并激活 SW 后，Host 暂不可达时刷新仍能显示 App Shell。
   - Cache Storage 不含 API response / pairing URL。
7. **update**
   - 发布新 build。
   - active turn 期间不自动 reload。
   - idle 后出现更新提示；点击后切换版本并刷新。
8. **Tauri Desktop**
   - 正常启动和 Chat。
   - DevTools/Application 中无本任务注册的 Web Service Worker。

## Rollback / Risk Checks

- network lifecycle 与 SW 分提交，SW 可独立回滚。
- 不改变 Remote auth/token 格式。
- 不改变 WebSocket event schema。
- 不缓存业务 API。
- 不为了 SW 给 LAN Host 增加 TLS。
- 若新增 build dependency，先确认 Vite 8 兼容；不引入额外 test/lint framework。

## Before `task.py start`

- [ ] `prd.md` 无 blocking open question。
- [ ] `design.md` 与本计划一致。
- [ ] `implement.jsonl` / `check.jsonl` 已填入真实 spec context。
- [ ] 用户在最终 planning summary 之后再次明确批准实施。
