# 目录与边界

## 目录结构

以下路径均相对仓库根目录：

| 路径                                              | 职责                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `desktop/nsh.json`                                | 应用元数据；`rust` 指向 native；运行时别名 `@` 指向共享 src |
| `desktop/tsconfig.json`                           | 继承 nsh 生成的类型配置；别名同时在此声明供类型检查使用     |
| `desktop/App.tsx`                                 | 导入字体，初始化 i18n，`mount(AppShell)`                    |
| `desktop/app/AppShell.tsx`                        | 应用外壳；业务视图放 app 层，不塞进基础组件                 |
| `desktop/app/fonts.ts`                            | 字体资源注册入口                                            |
| `desktop/app/i18n.ts`                             | 共享 i18next 的原生响应式适配                               |
| `desktop/ui/`                                     | 组件、前景色上下文、主题样式辅助函数                        |
| `desktop/fonts/`                                  | 应用内字体和许可证                                          |
| `desktop/theme.json`、`desktop/claude-theme.json` | 生成的完整主题                                              |
| `desktop/native/`                                 | 独立 Rust workspace，导出原生模块                           |
| `desktop/tests/`                                  | nsh 测试及独立打开的 fixture 应用                           |
| `desktop/spikes/m0/`                              | 归档原型，不是正式入口；已从桌面 tsconfig 排除              |

## 状态和共享代码

nsh TSX 使用 `signal`、`computed`、`mount`；组件约定集中在[基础组件](./component-guidelines.md)。

`desktop/nsh.json` 的 resolve alias 影响打包，tsconfig 的 paths 影响类型。共享 `src/` 代码的整个导入链不得依赖 `window`、`document`、`Storage`、React 绑定或 Tauri API，应拆出纯类型/纯函数，见[界面层对应](../../tasks/11-19-nsh-desktop-migration/design.md#5-界面层对应)。`desktop/tsconfig.json` 继承 nsh 生成配置，本身没有添加 DOM lib；现有复用回归入口是 `desktop/tests/shared-logic.test.ts`。

## 原生模块边界

- TSX 从 `app/native` 导入 `Pilo`、`AppInfo`；实现与注册见 `desktop/native/src/lib.rs`、`desktop/native/src/pilo.rs`。声明由 Rust 类型生成，不手写替代声明。
- `desktop/native/Cargo.toml` 以 `default-features = false` 引用现有 pilo crate；`src-tauri/Cargo.toml` 的默认 Tauri feature 属于旧壳。运行时业务层不得依赖 Tauri；平台路径、事件、Web 资源由壳适配。现有桥接使用 `HostPaths`、`HostEvents`、`WebAssets`。
- 运行时仍在 `src-tauri/src/runtime/`，协作与抽离规则见[迁移协作规则](./quality-guidelines.md#迁移协作规则)。
- `bootstrap()` 返回 projects、chatSessions、preferences 和 `eventSequence`，见 `desktop/native/src/pilo.rs` 的 Bootstrap/load_bootstrap，以及 `desktop/tests/bootstrap-fixture.tsx`。事件序列在读取快照状态前截取，不是 transcript watermark。
- `Pilo` 构造时通过 `runtime.subscribe_events` 订阅，早于首次 bootstrap。`nextEvents(max)` 返回 events/gap/closed 批次；队列有容量限制，溢出 gap 为包含端点的丢失区间。`ShellEvents.emit` 为空实现；运行时事件批次来自独立 EventStream。见 `desktop/tests/runtime-events-fixture.tsx`、`desktop/tests/runtime-events.test.ts`。
- 轮询协议依 `desktop/README.md`：每次只发起一个 nextEvents，max 为正安全整数；gap 后在同一 Pilo 实例重新 bootstrap 并继续轮询；在 transcript 自带序列前不按 eventSequence 丢弃聊天增量，transcript 重载延后到 turn idle。
- 壳维护 Tokio executor、数据路径和资源解析。默认数据路径沿用旧 Tauri 标识，不以 nsh 应用 ID 替换；测试使用隔离路径，不与 Tauri 同时写同一数据库，见[数据与兼容](../../tasks/11-19-nsh-desktop-migration/design.md#8-数据与兼容)及[数据迁移验收](../../tasks/11-19-nsh-desktop-migration/feature-parity.md#数据迁移验收)。退出前等待 `shutdown()`，见 `desktop/README.md`。偏好、项目/会话列表及已读状态接口也以该 README 和原生实现为准。
