# 质量与验证

## 迁移协作规则

- 当前只做 macOS；Tauri 壳已从仓库移除，桌面端只有 nsh 版本，WebUI 保留 React（`web/`）。nsh 版发版流程尚未建立。范围见[迁移 PRD](../../tasks/11-19-nsh-desktop-migration/prd.md)和[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)；清单里的「Tauri 基线」链接指向删除前的提交，需要时用 git 历史查看。
- 用户可见的功能改动两端都做：桌面端写在 `desktop/`，WebUI 写在 `web/`，与界面无关的逻辑放进 `shared/`。
- 运行时位于 `crates/pilo-runtime`（数据模型在 `crates/pilo-domain`），壳只做适配，见[目录与边界](./directory-structure.md#原生模块边界)。
- 每个功能完成后立即充分测试并提交，不攒文件合并成一次提交；测试覆盖实际正常、空态和失败行为。
- nsh 交付分别运行 headless 与 macOS 原生测试；浏览器回归单独验证，结果按功能记录提交、测试、证据。验收项目见[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)，测试分层见[迁移设计](../../tasks/11-19-nsh-desktop-migration/design.md#10-测试)。

## macOS 打包待办

建立 nsh 发版流程时，在最终 `.app` 的 `Info.plist` 加入 `NSLocalNetworkUsageDescription`，并确认完整包签名使用约定的 `app.hsingjui.pilo` 标识。仅有 Rust 链接器临时签名时，签名标识可能不匹配 macOS 本地网络授权记录，表现为终端能连而桌面 SSH 报 `No route to host`。验收应检查最终产物签名，并从安装后的应用验证局域网连接，而不只在终端验证 TCP。

## 测试组织

测试位于 `desktop/tests/`，从 nsh/test 导入 test/expect/open；fixture 是独立 mount 的应用。原生调用采用 `desktop/tests/native.test.ts` 与 `desktop/tests/native-fixture.tsx` 的模式：测试文件 open fixture，fixture 内导入并调用 app/native，不在测试文件直接调用。

文本断言采用 `app.texts()` 或 `app.shows("text:...")`，见 `desktop/tests/native.test.ts`、`desktop/tests/i18n.test.ts`；不使用 app.text(selector)。

headless 不绘制，滚动条 thumb/动画需要原生验证，见 `desktop/ui/README.md`。测试范围与交付要求统一遵循上面的迁移协作规则。

## 验证命令

根目录脚本定义在 `package.json`：

```bash
pnpm format
pnpm check
pnpm build
pnpm desktop:generate:themes --check
pnpm desktop:generate:icons --check
```

`pnpm format` 为 oxfmt write，check 为格式检查与 oxlint。`.oxfmtrc.json` 排除了 Trellis；该目录 Markdown 可用 oxfmt stdin 模式格式化，再次输入格式化结果检查幂等。

在 desktop 目录执行（不是 pnpm scripts）：

```bash
cd desktop
nsh check
nsh test
nsh test --target macos
nsh dev
```

nsh check 包含原生 crate 与类型检查；nsh test 包含应用 Rust 测试和 headless 测试；nsh dev 为本机窗口入口。命令含义见 nsh CLI help，迁移验证要求见[测试设计](../../tasks/11-19-nsh-desktop-migration/design.md#10-测试)。

桌面 crate 有独立 workspace，根 workspace 的 cargo 命令覆盖不到它：

```bash
cargo fmt --manifest-path desktop/Cargo.toml --all --check
cargo test --manifest-path desktop/Cargo.toml
cargo test -p pilo-runtime -p pilo-domain
```

共享纯 TS 回归对应 `pnpm test:unit`、`pnpm test:integration`；Rust 完整 fmt/check/clippy 流程仍见根 AGENTS 的 Validation。
