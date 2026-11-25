# 质量与验证

## 迁移协作规则

- 迁移功能验证以 macOS 为主；发布构建覆盖的平台见 [nsh 发版说明](../../../app/README.md#release-builds)。Tauri 壳与 React 前端均已从仓库移除，桌面端（`App.tsx` + `app/`）和 Remote WebUI（`web/`）统一基于 nsh 实现。范围见[迁移 PRD](../../tasks/11-19-nsh-desktop-migration/prd.md)和[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)；清单里的「Tauri 基线」链接指向删除前的提交，需要时用 git 历史查看。
- 用户可见的功能改动按需同步两端：桌面端与共用界面写在 `app/`，Remote WebUI 写在 `web/`，与界面无关的纯 TypeScript 逻辑放进 `shared/`。
- 运行时位于 `crates/pilo-runtime`（数据模型在 `crates/pilo-domain`），壳只做适配，见[目录与边界](./directory-structure.md#原生模块边界)。
- 每个功能完成后立即充分测试并提交，不攒文件合并成一次提交；测试覆盖实际正常、空态和失败行为。
- nsh 交付分别运行 headless 与 macOS 原生测试；浏览器回归单独验证，结果按功能记录提交、测试、证据。验收项目见[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)，测试分层见[迁移设计](../../tasks/11-19-nsh-desktop-migration/design.md#10-测试)。

## nsh 发布打包

- **触发**：`.github/workflows/release.yml` 支持手动构建与 `v*` tag 推送。手动操作只上传 Artifacts；版本匹配的 tag 在三个构建全部成功后创建草稿。
- **入口**：`nsh package --target <macos|windows|linux> --out .nsh/release`。该命令只生成 nsh 应用；发布包还需要 `scripts/build-nsh-web.mjs` 的 `dist/` 和同次 run 的 `pilo-server-runtimes` artifact。
- **资源布局**：macOS 在 `Pilo.app/Contents/Resources/`，Windows/Linux 在 `Pilo/` 内与可执行文件同级。WebUI 放 `webui/`，四个运行时放 `runtime/`，Unix 打包保留可执行权限。
- **失败条件**：版本文件不一致、tag 不匹配、`dist/index.html` 或任一运行时文件缺失、发布或更新签名密钥缺失或签名失败时，不产出 Release 草稿。
- **发布签名**：手动构建只上传各平台包，不生成 `.sig`；tag 构建在创建草稿前用原 Tauri 签名密钥给每个最终下载包生成同名 `.sig`。这些签名用于下载验签，不替代 macOS 应用的 ad hoc 签名。旧 Tauri 用户手动安装一次 nsh 版，不提供旧版更新清单。
- **nsh 更新**：同一份注入了 `NSH_UPDATE_PUBLIC_KEY` 和 GitHub 更新源的 `nsh.json` 用于打包及生成清单。用 `NSH_UPDATE_PRIVATE_KEY` 签 `latest.json.sig`；清单只引用最终的 Windows 便携 ZIP、macOS `.app` tarball 和 Linux tarball，不引用安装器或 DMG。三个更新包的文件名用不带 `v` 的版本（如 `Pilo-0.4.1-linux-x86_64.tar.gz`），下载基址用带 `v` 的 tag。否则 `nsh update-manifest` 无法解析包名。默认更新源不提供草稿或预发行版本。
- **Linux AppImage**：发布流程固定 `appimagetool` 和 Type 2 runtime 的版本及 SHA-256，任一校验失败即停止打包；用 `--runtime-file` 传入已校验的 runtime，不允许工具自行下载。`AppRun` 设置 `PILO_APPIMAGE=1`，通过 `nsh.json` 的 `capabilities.process.env` 提供给桌面更新逻辑。挂载或 `--appimage-extract-and-run` 启动时，发现新版本都只打开 Release 页面，不下载或原地替换；不能依赖目录不可写来识别 AppImage。普通 tarball 不设此标记，保留 nsh 的更新判断。
- **Windows 更新布局**：nsh 会替换可执行文件所在目录。Inno Setup 将应用文件放在 `pilo-app` 子目录，卸载器留在父目录。更新顺序是 `downloadUpdate()` → `installOnQuit()` → 等待 `client.shutdown()` → `Application.restart()`；暂存或关闭 Host 失败时不继续重启。在有本地会话的 Windows 安装版上确认重启后已换成新版。
- **更新说明与重试**：桌面 JS 只获准对 `https://api.github.com/repos/hsingjui/pilo/releases/tags/` 发 `GET`；失败时仍显示清单提供的说明。重新检查更新先关闭旧弹窗，再清空旧版本；只有找到更新才重新打开，避免无弹窗时仍禁用快捷键。
- **Windows 更新代理**：桌面端用 `DesktopUpdates.checkForUpdate(options)` 启动 nsh 原有检查，只替换该次检查的 `UpdaterHost` HTTP 传输。nsh 会保留该 host 给 `downloadUpdate()`；清单、签名和更新包的每次请求都新开 WinHTTP 自动代理会话，由 Windows 处理当前用户的代理、PAC、绕过规则和重定向。系统判定直连时直接连接；请求失败时报告错误，不再尝试走进程代理环境变量。nsh 0.7 的 `UpdaterHost::get` 收到非零偏移时，WinHTTP 发送 `Range: bytes=<offset>-`，并用 `Accept-Encoding: identity` 保持字节偏移一致。仅在 `206` 的 `Content-Range` 与请求偏移和响应长度相符时追加，`sink(offset, chunk, total)` 的总量是完整文件大小；`200` 从偏移 0 上报，`416` 或无效的 `206` 不上报任何数据，由 nsh 从头重试。验签、包校验和退出安装仍由 nsh 处理。不要在检测时把单个代理地址写入 `HTTPS_PROXY`：ureq 会缓存配置，PAC 也可能为下载地址选择不同代理。验收用已安装的 Windows 版本：验证手动代理、PAC/绕过、无代理，并在检查完成后改代理再下载，无需重启即可生效；同时确认签名或哈希不匹配仍拒绝安装。
- **更新进度**：`downloadUpdate` 的 `received` 是累计已收字节，`total` 可缺省。只在下载中且总量有效时显示百分比和进度条；未知总量时只显示已收到的字节，不用固定宽度模拟进度。
- **验收**：检查安装或解压后的应用能启动 Local、发布 Remote WebUI，并从安装版验证局域网 SSH。macOS 确认最终 `Info.plist` 含 `NSLocalNetworkUsageDescription`，签名标识为 `app.hsingjui.pilo`；只有 Rust 链接器临时签名时，局域网授权记录可能无法匹配，表现为终端能连而应用报 `No route to host`。
- **打包顺序**：共用运行时构建先对 macOS 的 `pilo-server` 做 ad hoc 签名，三端复制同一份产物。`nsh package` 对初始 `.app` 签名；Pilo 加入资源后单独验证 macOS 运行时签名，保留 entitlements 重新签名整个 `.app`，再生成 DMG 和更新 tarball。直接上传 nsh 初次生成的 ZIP、安装器或 tarball 会遗漏资源。

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
