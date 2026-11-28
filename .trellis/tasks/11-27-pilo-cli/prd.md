# Pilo 终端 CLI

## 目标

在终端用 `pilo` 打开桌面应用、读写设置、管理项目和会话。CLI 是与桌面 UI、Remote WebUI 并列的第三个 Host 客户端，也是未来 skill / Pi 插件的稳定入口。

## 需求

1. 新建 `crates/pilo-cli`，提供 `pilo` 二进制，复用 Host API v2。Host 仍在桌面进程中，不拆 daemon。
2. 本机 CLI 不开 TCP 端口、不依赖 Remote WebUI，也不要求 token、配对或确认。通过 OS 用户边界连接，同一用户拥有完整本机 Host 权限。打包时将 App ID 编入 CLI：正式包安装 `pilo`，默认连接 `app.hsingjui.pilo`；开发包安装 `pilo-dev`，默认连接 `app.hsingjui.pilo.dev`。保留 `--dev` 覆盖默认值，改名不改变默认实例。
3. `pilo open` 启动或激活 PATH 入口关联的桌面 App；安装版与便携版并存时，在想切换到的 App 中安装或修复 CLI。`pilo open <path>` 打开目录对应的项目，未登记则添加；`pilo open --session <id>` 打开已有会话，支持唯一前缀且歧义时列出候选。其他 Host 命令默认不启动 App；加 `--launch` 才启动并等待连接就绪，否则给出打开应用的提示。
4. 支持设置（偏好读写、主题）、项目（列出、新增、移除）、会话（列出、读取、历史、新建、发送、打断、停止、归档、恢复、删除、更新）。`pilo sessions status <id>` 一次性查看会话状态和最近回复；不订阅事件、不启动 Pi。业务命令默认 JSON 输出；提供 `--help` 和 `version`；记录稳定命令及 JSON 契约。
5. 桌面「设置 → 其他」在「关于」旁提供「CLI」页：显示状态、路径及版本，支持安装、卸载、修复。macOS 默认经一次系统管理员授权建立 `/usr/local/bin/pilo` 软链，取消授权时改用 `~/.local/bin` 并说明如何加入 PATH；Linux deb/tar 用 `~/.local/bin`，AppImage 链接到由 App 更新的持久副本。Windows 把应用专用 `bin` 加入用户 PATH，直接运行 `pilo.exe` 或 `pilo-dev.exe`。CLI 随 App 更新，无独立更新器；Remote WebUI 不提供此入口。
6. 完全删除旧 `pilo-server ctl` 及其能力链路，不保留兼容入口。接受 SSH/WSL 内的 Pi 不再能通过旧方式自控；本机 Pi 可运行 PATH 中的 `pilo`，权限与同一用户的终端一样。

## 验收标准

- [ ] Remote WebUI 关闭时，同一用户仍可管理 Host；其他用户被拒绝；不新增 TCP 监听；dev 与 release 同时运行时不会误连，协议不兼容明确报错。超长 Unix socket 路径或 Linux 未配置运行时目录时可用安全短路径。
- [ ] 冷启动和已有窗口下均可 `open`；校验实际运行的是 PATH 入口关联的 App，遇到同标识的另一份 App 时提示先退出，不导航或虚报成功。已有项目不重复添加，未登记目录能添加并进入，指定会话可定位；普通命令离线时不擅自启动，`--launch` 在有限时间内就绪后执行一次或明确失败。
- [ ] CLI 改动与桌面 / WebUI 的项目、设置、会话一致；首条消息被 Pi 确认后才报告接受；abort 不等于 stop，archive 不等于 delete；不自动重放结果未知的写请求。
- [ ] `sessions status` 区分空闲、运行中、压缩中、未运行和错误；能判断当前工具时返回名称，不能判断时不猜测。查询已停止的会话不启动 Pi。
- [ ] macOS 验证默认位置的授权、取消后的用户目录回退，以及卸载/修复授权；Windows 验证用户 PATH 去重、直接执行 EXE、原地更新无需重写 PATH；Linux 验证软链和 AppImage 卸载挂载后 CLI 仍可执行。各平台验证重复安装、卸载、移位修复、dev/release 共存、第三方冲突及 PATH 遮蔽；WebUI 不显示此页。
- [ ] 旧 ctl 命令、授权环境、协议分发和 SSH 注入均不存在；Local/WSL/SSH 的正常 Pi 启动和项目会话操作不受影响。

## 不在本期

独立或纯 headless Host、远端 Pi 的 CLI 转发、skill / Pi 插件本身、实时 `sessions watch`、通过 CLI 回答扩展 UI 请求、`sessions send --wait`、通用 `pilo api` 调用。CLI 在本机管理 Host 托管的 SSH/WSL 项目，不等同于在远端运行 CLI。
