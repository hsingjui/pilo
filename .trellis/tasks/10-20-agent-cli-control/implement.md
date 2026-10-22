# 实施计划

## 状态与前置条件

用户已明确批准实施，任务已启动为 in_progress。主会话完成代码接入，尚未获准运行测试、构建或真实窗口验证。

子 Agent 在本项目禁用：主会话 inline 实施，跳过 JSONL curation，Phase 2 用 trellis-before-dev 加载规范。

## 执行顺序

1. 重读 PRD/设计，加载 backend、frontend 与共享 guides；检查 git status/diff，不覆盖其他任务。重新核对设置清单与代码定位，避免时间间隔造成事实漂移。
2. 列出所有设置及真实 setter/重置、类型、作用域、secret、平台能力，覆盖设置页、远程访问与项目模型 Scope。
3. 增加 typed 控制消息/能力协商，复用 Envelope；实现 pilo-server ctl、本机 loopback、上下文注册、事件回传、响应及取消。兼容旧启动/版本/指纹。
4. Host 独立 dispatcher 执行配置业务；确保订阅建立顺序、背压与可重入，不阻塞 Host reader。
5. 为普通及临时交互 Pi 注入 CLI 路径、使用说明和自动上下文。覆盖 Local/WSL/远端 Pi；混合 SSH 确保远端 Server 并在 bash wrapper 注入远端上下文。
6. 实现 Host 通用偏好/语言存储、字段 patch、revision 与一次迁移。改造共享 PiloClient/provider/remote 恢复流程，同步桌面与 WebUI，不复制 UI。
7. 完成全部设置 catalog/get/set/reset 与 stdin 秘密写入，复用 keyring、系统能力及现有验证。
8. 完成跨连接查询、连接配置保存、已有项目添加，保留完整生命周期和 Runtime 广播。
9. 全量 diff 静态审阅，按 AC1–AC8 与设置清单逐项对照；记录实际未验证项。按 trellis-check/update-spec 判断需补充的约束，不自动提交或发布。

## 预计影响层与风险文件

- crates/pilo-server：入口、控制传输、Pi 启动、SSH 扩展及部署兼容。
- crates/pilo-protocol：新增受控消息与能力，不无故重构 framing。
- src-tauri runtime：Host 控制 dispatcher、存储/迁移、原生系统 setter、ServerManager 生命周期。
- src/lib/api、preferences/i18n 与 src/remote：共享快照、事件、缓存与重连。

重点回看：stream 单订阅、回包优先级、pending 有界、会话失效；混合 SSH 的真正远端 PATH；修改当前连接不切断自身结果；Windows GUI/console 输出；旧缓存不覆盖 Host；秘密脱敏及原有认证不削弱。

## 验证计划（另获明确请求后执行）

当前用户没有要求执行验证，不运行构建、测试；测试代码未经明确请求不新增或修改。以下仅记录待授权的检查。

前端：pnpm format；pnpm check；pnpm build。
Rust：cargo fmt --all --check；cargo check；cargo clippy --all-targets --all-features -- -D warnings。

Windows 侧进行桌面窗口与 pnpm tauri dev 验证，WSL 只做获准的开发/静态检查。WebUI 覆盖宽屏、窄屏、重连。四种运行模式分别检查跨连接读写、项目添加、失效上下文、Host 断开和清理。

迁移检查：已有旧配置、Host 已有数据、CLI 先写、离线 WebUI、并发 patch、设备字体缺失、系统通知权限拒绝。回滚保留旧客户端缓存，避免破坏已有会话和配置。

## 本轮实际操作与剩余验证

- 已实现 ctl 入口、类型化协议、有界 loopback 通道、Host 反向分发、交互会话注入与生命周期回收。
- 已接入 Local/WSL/远端 Pi，以及本地 Pi + SSH 工作区的远端控制路径；Windows 开发启动会准备控制台 CLI。
- 已增加设置清单与 setter/reset、连接保存/查询和已有项目添加；没有开放任意 invoke、秘密读取或删除项目。
- 已实现 Host 偏好/语言存储、revision、一次迁移、字段级并发 patch、桌面/WebUI 事件及重连恢复；旧缓存可写时保留 `.legacy` 备份。
- 已审阅变更调用链、生命周期和两端事件消费者；使用 rustfmt（skip_children）及 oxfmt 仅格式化本次变更，`git diff --check` 无输出。
- 已更新 backend/agent-control.md 与 frontend/state-management.md。未修改测试，未执行测试、构建、类型检查或 linter，未启动 Windows/WebUI；未提交。

AC1–AC8 已有对应代码路径，但不得将静态审阅视为运行验收。剩余工作是用户授权后执行上述验证计划，重点覆盖四种运行模式、迁移并发、原生系统拒绝、断线与秘密不出现在 argv/事件。
