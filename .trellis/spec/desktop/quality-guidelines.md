# 质量与验证

## 迁移协作规则

- 当前只做 macOS；Tauri 仍为发版应用，nsh 在 nsh-migration 构建，WebUI 保留 React。范围见[迁移 PRD](../../tasks/11-19-nsh-desktop-migration/prd.md)和[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)。
- main 的 Tauri/WebUI UI 改动继续按共享 React 组件维护；迁移分支每次合入 main 时登记期间桌面可见改动，在对应里程碑补到 nsh，见[过渡期规则](../../tasks/11-19-nsh-desktop-migration/design.md#11-过渡期规则)。
- 运行时抽离留在原路径，不顺带改业务语义；业务修复先进 main，见[运行时抽离](../../tasks/11-19-nsh-desktop-migration/design.md#3-rust-运行时抽离)。
- 每个功能完成后立即充分测试并提交，不攒文件合并成一次提交；测试覆盖实际正常、空态和失败行为。
- nsh 交付分别运行 headless 与 macOS 原生测试；浏览器回归单独验证，结果按功能记录提交、测试、证据。验收项目见[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)，测试分层见[迁移设计](../../tasks/11-19-nsh-desktop-migration/design.md#10-测试)。

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

独立 native workspace 与无 Tauri 运行时的检查入口：

```bash
cargo fmt --manifest-path desktop/native/Cargo.toml --all --check
cargo test --manifest-path desktop/native/Cargo.toml
cargo test -p pilo --lib --no-default-features
```

共享纯 TS 回归对应 `pnpm test:unit`、`pnpm test:integration`；Rust 完整 fmt/check/clippy 流程仍见根 AGENTS 的 Validation。
