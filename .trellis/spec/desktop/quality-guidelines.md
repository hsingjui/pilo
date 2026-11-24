# 质量与验证

## 迁移协作规则

- 迁移功能验证以 macOS 为主；发布构建覆盖的平台见 [nsh 发版说明](../../../app/README.md#release-builds)。Tauri 壳与 React 前端均已从仓库移除，桌面端（`App.tsx` + `app/`）和 Remote WebUI（`web/`）统一基于 nsh 实现。范围见[迁移 PRD](../../tasks/11-19-nsh-desktop-migration/prd.md)和[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)；清单里的「Tauri 基线」链接指向删除前的提交，需要时用 git 历史查看。
- 用户可见的功能改动按需同步两端：桌面端与共用界面写在 `app/`，Remote WebUI 写在 `web/`，与界面无关的纯 TypeScript 逻辑放进 `shared/`。
- 运行时位于 `crates/pilo-runtime`（数据模型在 `crates/pilo-domain`），壳只做适配，见[目录与边界](./directory-structure.md#原生模块边界)。
- 每个功能完成后立即充分测试并提交，不攒文件合并成一次提交；测试覆盖实际正常、空态和失败行为。
- nsh 交付分别运行 headless 与 macOS 原生测试；浏览器回归单独验证，结果按功能记录提交、测试、证据。验收项目见[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)，测试分层见[迁移设计](../../tasks/11-19-nsh-desktop-migration/design.md#10-测试)。

## nsh 发布打包

- **触发**：`.github/workflows/release.yml` 支持手动构建与 `v*` tag 推送。手动操作只上传 Artifacts；版本匹配的 tag 在三个构建全部成功后创建草稿。
- **入口**：`nsh package --target <macos|windows|linux> --out .nsh/release`。该命令只生成 nsh 应用；发布包还需要 `pnpm build` 的 `dist/` 和同次 run 的 `pilo-server-runtimes` artifact。
- **资源布局**：macOS 在 `Pilo.app/Contents/Resources/`，Windows/Linux 在 `Pilo/` 内与可执行文件同级。WebUI 放 `webui/`，四个运行时放 `runtime/`，Unix 打包保留可执行权限。
- **失败条件**：版本文件不一致、tag 不匹配、`dist/index.html` 或任一运行时文件缺失时，不产出 Release 草稿。
- **预期结果**：手动构建可以下载各平台包但不创建 Release；tag 构建的草稿包含和 Artifacts 相同的包，不包含 Tauri 更新文件。
- **验收**：检查安装或解压后的应用能启动 Local、发布 Remote WebUI，并从安装版验证局域网 SSH。macOS 确认最终 `Info.plist` 含 `NSLocalNetworkUsageDescription`，签名标识为 `app.hsingjui.pilo`；只有 Rust 链接器临时签名时，局域网授权记录可能无法匹配，表现为终端能连而应用报 `No route to host`。
- **打包顺序**：先把资源放入应用目录，再重新归档，并在 macOS 上对修改后的 `.app` 重新签名。直接上传 nsh 初次生成的 ZIP、安装器或 tarball 会遗漏资源。

## 测试组织

测试位于 `app/tests/`，从 nsh/test 导入 test/expect/open；fixture 是独立 mount 的应用。原生调用采用 `app/tests/native.test.ts` 与 `app/tests/native-fixture.tsx` 的模式：测试文件 open fixture，fixture 内导入并调用 app/native，不在测试文件直接调用。

文本断言采用 `app.texts()` 或 `app.shows("text:...")`，见 `app/tests/native.test.ts`、`app/tests/i18n.test.ts`；不使用 app.text(selector)。

headless 不绘制，滚动条 thumb/动画需要原生验证，见 `app/ui/README.md`。测试范围与交付要求统一遵循上面的迁移协作规则。

## 验证命令

根目录脚本定义在 `package.json`：

```bash
pnpm format
pnpm check
pnpm build
pnpm generate:themes --check
pnpm generate:icons --check
```

`pnpm format` 为 oxfmt write，check 为格式检查与 oxlint。`.oxfmtrc.json` 排除了 Trellis；该目录 Markdown 可用 oxfmt stdin 模式格式化，再次输入格式化结果检查幂等。

在仓库根目录执行 nsh 命令：

```bash
nsh check
nsh test
nsh test --target macos
nsh dev
```

nsh check 包含原生 crate 与类型检查；nsh test 包含应用 Rust 测试和 headless 测试；nsh dev 为本机窗口入口。命令含义见 nsh CLI help，迁移验证要求见[测试设计](../../tasks/11-19-nsh-desktop-migration/design.md#10-测试)。

桌面 crate 有独立 workspace，根 workspace 的 cargo 命令覆盖不到它：

```bash
cargo fmt --manifest-path crates/pilo-desktop/Cargo.toml --all --check
cargo test --manifest-path crates/pilo-desktop/Cargo.toml
cargo test -p pilo-runtime -p pilo-domain
```

共享纯 TS 回归对应 `pnpm test:unit`、`pnpm test:integration`；Rust 完整 fmt/check/clippy 流程仍见根 AGENTS 的 Validation。
