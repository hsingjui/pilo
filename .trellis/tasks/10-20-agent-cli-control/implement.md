# 实施计划

## 状态与前置条件

任务已按用户明确请求创建，状态 planning。仅创建任务不构成实施批准；不得运行 task.py start 或修改产品代码。前面临时目录当前已不存在，本任务文档依据会话里的需求、设计与计划重建，正式来源改为本任务目录。

子 Agent 在本项目禁用：主会话 inline 实施，跳过 JSONL curation，Phase 2 用 trellis-before-dev 加载规范。

## 执行顺序（批准后）

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

## 本轮实际操作

项目内 .trellis/scripts/task.py 已缺失，本轮使用已安装 Trellis 的打包脚本创建任务，PYTHONDONTWRITEBYTECODE=1 避免写入项目外 Python 缓存。未修复/覆盖项目的 Trellis 安装，也未运行 start、构建或测试。
