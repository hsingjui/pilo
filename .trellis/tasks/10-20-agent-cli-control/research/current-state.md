# 现状与证据

本文记录此前主会话调研和创建任务时的复核，不代表已经实现或验证。

## 入口与传输

- pilo-server 现有入口处理版本/指纹与默认 stdio Server；开发版 Local 可由桌面 --pilo-server 模式启动。
- Host 的 server_client reader 处理 Response 和 Event；不是现成的通用 Server→Host RPC。新 CLI 不能直接抢用父进程现有 stdin/stdout。
- 现有 Envelope 足以承载专用控制事件和回包方法，优先添加有类型的控制能力。
- 项目检视已通过 ServerManager 使用目标环境的 Server，SSH 混合模式可复用远端部署，不必引入反向端口。

## 设置与生命周期

- 设置页存在 appearance/preferences/fonts/shortcuts/desktop/connections/models/输入辅助等分组，远程访问另有面板。实施时应完整列清单，而非只遍历一个组件。
- `src/lib/preferences-provider.tsx:47`、`:205` 的偏好当前在 localStorage；locale 独立本地持久化。主题已有 Host 存储与 WebUI 同步。
- `crates/pilo-server/extensions/ssh-workspace.js:136`、`:658` 在远端执行 bash，只注入本地 Pi env 不足以提供 CLI。
- `src-tauri/src/runtime/project.rs:53` 管理规范化与稳定 ID；commands/projects.rs 另有 open_project。连接和项目的页面 DOM 通知不足以支撑 CLI 修改。
- SSH 密码保存在现有系统凭据库。CLI 复用写入，不开放普通查询的明文输出。

## 任务创建环境

创建时原 `.tmp/pilo-control-plan/` 和旧 HTTP 页面目录已不存在，不应继续把临时报告当作正式材料。已依据本会话重建 prd/design/implement。

本地 `.trellis/scripts/task.py` 缺失；使用已安装 @mindfoldhq/trellis 0.6.17 的模板 task.py（按当前 cwd 定位项目），禁用 Python bytecode 写入。创建成功并自动激活本会话，task.json.status 为 planning；没有运行 start。

创建时工作区没有已存在的未提交改动。实施前需重新检查，不能把这个快照当作长期保证。未运行任何构建或测试。
