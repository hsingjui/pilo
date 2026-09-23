# Remote WebUI Implementation Plan

## 1. Host-side Remote Configuration

- Rust Host 增加 Remote 配置持久化，默认 disabled。
- 定义 listener start/stop/restart/shutdown。
- 启动时恢复开关状态，退出时显式停止 listener。
- 验证 fresh install、enable、disable、restart。

## 2. Lightweight Authentication

- pairing secret：随机、高熵、hash 存储、5 分钟过期、单次消费。
- device token：随机、高熵、hash 存储、30 天绝对过期。
- 增加 paired device SQLite schema/repository。
- 实现 pairing exchange、HTTP/WS auth、revoke device。
- secret/token 明文不得写日志。
- 验证重复使用、超时、过期、撤销。

## 3. Application Service Boundary

- 围绕 MVP 抽取可复用 Host API：connections/projects/sessions、history/snapshot、create/open、runtime state、prompt、steer/follow-up、abort、context/model。
- Tauri command 与 Web adapter 调用同一 service，不复制逻辑。
- 保持 Desktop 现有行为。

## 4. Multi-subscriber EventBus

- RuntimeEventBus 改为多 subscriber。
- 保留 Tauri subscriber adapter，增加 Web subscribers。
- subscriber detach 不影响其他客户端。
- slow Web client 使用 bounded queue / drop+reconcile，不反压 Pi runtime。
- 验证 Desktop + Web 同时收到事件及高频 delta 性能。

## 5. HTTP / WebSocket Adapter

- 在现有 src-tauri crate 内引入 Axum + Tower/Tower-HTTP，不新建独立 Rust crate。
- 实现 static WebUI、health/bootstrap、pairing、authenticated MVP REST、events WebSocket。
- 实现 snapshot + sequence/replay contract。
- protocol DTO 不暴露 Tauri-specific 类型。

## 6. PiloClient Boundary

- 定义 transport-neutral PiloClient。
- 用 TauriPiloClient 包住现有 invoke/channel。
- 实现 WebPiloClient。
- 只迁移 Remote MVP 必需 feature，不顺手改 Files/Terminal/Git。

## 7. Mobile-first WebUI / PWA-ready Shell

- 增加 MobileLayout、Remote bootstrap/auth、Project/Session navigation。
- 优先适配 safe area、软键盘、触控目标、单手操作与前后台恢复。
- 复用 Chat message/thinking/tool-call rendering。
- 适配 Composer、context/model controls。
- 接入现有 Chat 图片附件 contract，支持手机相册/系统图片选择；不实现通用文件上传。
- 实现 offline/reconnecting/token-expired/remote-disabled 状态。
- 增加 Web App Manifest、icons、theme color 和 standalone-friendly app shell。
- 第一版不引入 Service Worker / offline cache / Web Push 作为依赖。
- Desktop Browser 只做基本响应式与功能可用验证。

## 8. Desktop Remote Settings

- enabled switch、LAN URL、QR/Magic Link、regenerate pairing、paired devices、expiry、revoke。
- Remote 生命周期和显示状态必须一致。

## 9. Reconnect / Multi-client Verification

- Desktop -> Web 与 Web -> Desktop 双向实时同步。
- busy turn 下 steer/follow-up/abort 语义一致。
- 浏览器后台恢复、Wi-Fi 短断线、replay gap -> snapshot recovery。
- Desktop 关闭 Remote、Pilo 退出、Pilo 重启 Remote=ON。
- token expired/revoked。
- 两个已认证 Web 客户端同时连接。

## Rollback Points

- Service/client boundary 可独立提交且不启用 Remote。
- EventBus multi-subscriber 可独立提交并保持仅 Desktop subscriber。
- Web Server 默认 disabled；出问题可通过 Remote OFF 完全回退到原 Desktop 路径。
