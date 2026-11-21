# 目录与边界

## 目录结构

以下路径均相对仓库根目录：

| 路径                                              | 职责                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `desktop/nsh.json`                                | 应用元数据；`"rust": "."`；运行时别名 `@shared` 指向 `shared/` |
| `desktop/tsconfig.json`                           | 继承 nsh 生成的类型配置；别名同时在此声明供类型检查使用     |
| `desktop/App.tsx`                                 | 导入字体，初始化 i18n，调用 `launch(new Pilo())`            |
| `desktop/app/AppShell.tsx`                        | 应用外壳，见[应用外壳](./app-shell.md)；业务视图放 app 层  |
| `desktop/app/fonts.ts`                            | 字体资源注册入口                                            |
| `desktop/app/i18n.ts`                             | 共享 i18next 的原生响应式适配                               |
| `desktop/ui/`                                     | 组件、前景色上下文、主题样式辅助函数                        |
| `desktop/fonts/`                                  | 应用内字体和许可证                                          |
| `desktop/theme.json`、`desktop/claude-theme.json` | 生成的完整主题                                              |
| `desktop/Cargo.toml`、`desktop/src/`              | 应用自己的 Rust crate（独立 workspace），导出 `app/native`  |
| `desktop/tests/`                                  | nsh 测试及独立打开的 fixture 应用                           |
| `desktop/spikes/m0/`                              | 归档原型，不是正式入口；已从桌面 tsconfig 排除              |

## 状态和共享代码

nsh TSX 使用 `signal`、`computed`、`mount`；组件约定集中在[基础组件](./component-guidelines.md)。

`desktop/nsh.json` 的 resolve alias 影响打包，tsconfig 的 paths 影响类型。桌面端只从 `@shared/*` 导入仓库内的 TS；`shared/` 的整个导入链不得依赖 `window`、`document`、`Storage`、React 或 nsh，`tsc -p shared`（无 DOM lib，只有 `shared/runtime-globals.d.ts` 声明的两端共有全局）和 oxlint 的 `no-restricted-imports` 会拦下，见[界面层对应](../../tasks/11-19-nsh-desktop-migration/design.md#5-界面层对应)。`desktop/tsconfig.json` 继承 nsh 生成配置，本身没有添加 DOM lib；现有复用回归入口是 `desktop/tests/shared-logic.test.ts`。

## 原生模块边界

- TSX 从 `app/native` 导入 `Pilo`、`AppInfo`；实现与注册见 `desktop/src/lib.rs`、`desktop/src/pilo/mod.rs`（nsh 每个 class 只允许一个 `#[class] impl` 块，导出方法都在这里；壳适配在 `pilo/shell.rs`，JSON 转换在 `pilo/encode.rs`，参数/返回类型在 `pilo/objects.rs`）。声明由 Rust 类型生成，不手写替代声明。
- `desktop/Cargo.toml` 依赖 `crates/pilo-runtime` 与 `crates/pilo-domain`。运行时业务层不依赖任何壳；平台路径、事件、Web 资源由壳适配，桥接使用 `HostPaths`、`HostEvents`、`HostShell`、`WebAssets`。
- `bootstrap()` 返回 projects、chatSessions、preferences 和 `eventSequence`，见 `desktop/src/pilo/objects.rs` 的 Bootstrap 与 `desktop/src/pilo/mod.rs` 的 load_bootstrap，以及 `desktop/tests/bootstrap-fixture.tsx`。事件序列在读取快照状态前截取，不是 transcript watermark。
- `Pilo` 构造时通过 `runtime.subscribe_events` 订阅，早于首次 bootstrap。`nextEvents(max)` 返回 events/gap/closed 批次；队列有容量限制，溢出 gap 为包含端点的丢失区间。`ShellEvents.emit` 为空实现；运行时事件批次来自独立 EventStream。见 `desktop/tests/runtime-events-fixture.tsx`、`desktop/tests/runtime-events.test.ts`。
- 轮询协议依 `desktop/README.md`：每次只发起一个 nextEvents，max 为正安全整数；gap 后在同一 Pilo 实例重新 bootstrap 并继续轮询；在 transcript 自带序列前不按 eventSequence 丢弃聊天增量，transcript 重载延后到 turn idle。
- 壳维护 Tokio executor、数据路径和资源解析。默认数据路径沿用旧 Tauri 标识，不以 nsh 应用 ID 替换；测试使用隔离路径，见[数据与兼容](../../tasks/11-19-nsh-desktop-migration/design.md#8-数据与兼容)及[数据迁移验收](../../tasks/11-19-nsh-desktop-migration/feature-parity.md#数据迁移验收)。退出前等待 `shutdown()`，见 `desktop/README.md`。偏好、项目/会话列表及已读状态接口也以该 README 和原生实现为准。

### SSH 密码认证入口

- **范围**：SSH 密码模式的部署、隧道、Local Pi SSH 工作区；不影响 SSH agent 或私钥模式。
- **入口**：nsh 的 macOS 开发和打包 runner 都在启动应用前注册原生模块。`desktop/src/lib.rs` 在注册时调用 `pilo_runtime::handle_ssh_askpass() -> Option<i32>`，只有收到退出码才立即退出。
- **输入**：`PILO_SSH_ASKPASS_CONNECTION_ID` 指向系统凭据，`SSH_ASKPASS` 必须指向当前可执行文件，且 `SSH_ASKPASS_REQUIRE=force`。不满足时按普通应用启动，不读取凭据。
- **结果**：成功只向 stdout 写密码并刷新，然后返回 0；凭据读取或输出失败返回非零。stderr 只允许[诊断元数据](../backend/logging-guidelines.md#connection-startup-diagnostics)。
- **好 / 基线 / 错误**：密码子进程回答 OpenSSH；普通启动和 SSH agent 照旧；缺失密码不能打开第二个应用窗口或返回成功。
- **验收**：macOS 开发和安装版分别验证密码连接、错误密码、SSH agent 连接及普通启动；密码不得出现在日志、参数或环境变量中。
- **不要**在 `Pilo::new()` 或 TSX 挂载后再处理 askpass；nsh 可能先按单实例规则把子进程当作第二次启动处理。
