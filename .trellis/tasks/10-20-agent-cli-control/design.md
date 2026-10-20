# 技术设计：Pilo 内置 Agent CLI 自控

状态：规划草案，延续此前最终方案，未获实施批准。

## 架构与职责

`Agent bash → pilo-server ctl → 当前环境的受管 Server → Pilo Host → 现有业务 → Runtime 事件 → 桌面/WebUI`。

CLI 负责参数和输出，Server 只做传输，Host 做身份/目标校验及业务执行。SQLite 不存 conversation 副本，Pi JSONL 仍是会话事实来源。不新增数据库脚本绕过业务，也不把所有 Tauri commands 反射暴露。

## CLI 与兼容

复用 pilo-server 二进制，在共享 Rust 库内增加 ctl 客户端模式。保留无参数 stdio Server、--version、--fingerprint；ctl 是短命进程，不创建 daemon。开发版桌面嵌入 Server 可以保留，但 Windows CLI 使用控制台兼容入口，不能依赖 GUI 子系统输出。

命令组建议为 status、settings list/get/set/reset、connections list/save、projects list/add。具体 key 由完整设置 catalog 收敛。复杂配置及秘密允许 stdin JSON；普通模式可读，--json 提供稳定机器结果。

## 本机控制与反向请求

建议每个受管 Server 绑定 IPv4 loopback 临时 TCP 端口，复用 Tokio net，不引入 HTTP 框架或公网管理端点。帧使用受限 JSON，请求、响应、并发与等待均有上限。

Host 先建立独立控制订阅，再注册运行中会话上下文；自动注入 CLI 路径、端点、实例标识与临时内部凭据。无需用户处理 token。内部凭据不是针对同用户恶意 shell 的安全隔离承诺。

Server 通过专用控制事件（如 control.request）回传 Host；Host 用正常 Host→Server 请求（如 control.respond）提交结果。优先复用当前 Envelope framing，只增加受控消息类型与能力协商。

关键约束：
- 订阅先于上下文发布；不抢占 Pi 原有唯一 stream 订阅。
- Host reader 只路由，业务在独立 dispatcher 执行；业务可重入同一 Server 而不死锁。
- 控制回包/取消不能被长任务饿死，pending 和输出受背压限制。
- Host 以已注册上下文判断来源，不信任请求自报身份；目标 connection/project 仍需验证。
- 超时、取消、断线与会话结束完成或清理 pending；写请求不盲目重放。
- 开发版、正式版与多个实例隔离，不猜最近启动的 Pilo。

## 跨环境与混合 SSH

普通 Local/WSL/远端 Pi 模式中，CLI 和受管 Server 在同一环境，沿现有 Server→Host 连接返回。复用 ServerManager 的部署、版本检查、缓存与生命周期，无需全局安装 CLI。

本地 Pi 加 SSH 工作区的 bash 在远端执行。利用既有 SSH Server 部署能力，显式连接远端 Server，并为本地交互会话注册远端控制上下文。扩展 SshWorkspaceConfig，由远端 bash wrapper 注入远端 CLI 路径和上下文。请求从远端 Server 返回同一 Host，不依赖 Windows localhost 或 SSH 反向端口。远端无需安装 Pi。

如需内置扩展，仅做简短 CLI 说明/环境适配，不复制业务为一组专用工具，不滥用 UI confirm 协议。内部辅助模型任务不注入自控。

## 全部设置业务入口

建立 typed catalog：key、类型、作用域、约束、secret、支持平台、交互条件；逐项映射现有 setter。必要时从 command 提取共享业务，但不做全面重构。

- theme 复用 appearance。
- 通用 preferences/locale 新增 Host 存储、字段 patch、revision。
- startup/close/global shortcuts 调用原有系统流程。
- connections、credentials、project scope、输入辅助功能调用现有所属模块。
- remote access 保留现有 manager、地址校验和重启语义。
- projects add 共享 inspect→upsert→open_project，路径由目标环境规范化。

secret 经 stdin 和受限通道写入系统 keyring。普通读取只返回已配置状态，不扩展秘密读取。修改当前连接需确保回包或明确报告影响，不在读循环持锁时销毁自身通道。

## 统一偏好与迁移

Host SQLite 为通用偏好事实来源；主题保留已有表/事件，不复制存储。共享 PiloClient 连接 provider、i18n 与 WebUI，客户端仅保存启动缓存。

迁移建议：已有 Host 字段优先，首次导入桌面旧 localStorage/locale 的有效字段并标记。WebUI 不初始化或覆盖 Host。若 CLI 先写部分字段，迁移只补尚未初始化字段，避免丢失旧偏好。保留旧缓存用于排查，不作为后续写入优先来源。

并发用字段 patch 与单调 revision，重连加载快照。字体缺失使用显示回退，不改写已保存值；快捷键复用平台中性表达与 Mod 映射。移动端字号、触控、安全区和布局保持可用。

桌面专属设置仍作用于 Host；不为 WebUI 增加插件通知开关或原生系统管理页。通用偏好统一同步，连接/项目仍各有作用域。

## 事件、结果与回退

提交后由 Runtime 广播全局或带 connectionId/projectId 的变更，连接/项目列表不再依赖调用页面 DOM 事件。事件和日志不含秘密或控制凭据；WebUI 用原有认证和重同步机制。

结果区分已保存、已生效、需要系统交互/重连等状态，系统拒绝不能报告成功。新旧协议能力不匹配沿用重新部署机制并给出明确错误。

风险：无新增审批意味着受信任的内置会话可直接改变凭据及远程访问；这是已讨论的产品方向。跨环境部署、迁移、断线清理需重点审查。实施前重看当前代码和工作区，不覆盖任何其他任务改动。
