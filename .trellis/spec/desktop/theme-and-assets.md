# 主题与资源

## 生成文件：只改输入，不手改输出

仓库根目录执行：

```bash
pnpm desktop:generate:themes
pnpm desktop:generate:themes --check
pnpm desktop:generate:icons
pnpm desktop:generate:icons --check
```

真实脚本为 `scripts/generate-desktop-themes.mjs`、`scripts/generate-desktop-icons.mjs`；`--check` 由 `scripts/write-generated.mjs` 检测过期输出，不写文件。

| 输入                                                       | 生成输出                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `web/styles/lody-theme.css`、`web/styles/claude-theme.css` | `desktop/theme.json`、`desktop/claude-theme.json`、`shared/theme-web-map.json` |
| `web/` 内具名 lucide-react 图标导入、`desktop/app/lucide-icon-names.json` 列出的仅桌面图标 | `desktop/app/lucide-icons.json`                                                 |

## Theme token

`cssVars` 是 nsh 可识别的颜色、数值/长度、字体族；用 `token()` 或 token class。`styleVars` 保留复合阴影、动效、简写和依赖布局的计算，不传给 token API；通过 `desktop/ui/theme-style.ts` 的 `styleVar()` 取值，再传 inline style。

切换族时成对调用 `setTheme({ cssVars: theme.cssVars })` 和 `setStyleTheme(theme.styleVars)`；恢复默认 Lody 时两者均传 null。亮暗取对应 appearance 的值。参考 `desktop/tests/ui-gallery-fixture.tsx`，不要只换颜色漏掉阴影。

生成器解析绝对长度计算；源主题没有通用 radius，组件使用命名 Pilo radius token。自定义主题使用 `shared/theme-tokens.ts` 的 catalog、`validateCustomThemeTokens`、`resolveCustomTheme` 共用纯逻辑，不接受任意 CSS 选择器；格式为 theme/light/dark token 表，校验失败不应用。详细类型与限制见 `desktop/README.md`，原生解析回归见 `desktop/tests/custom-theme.test.ts`。nsh 设置页（`desktop/settings/theme-pane.tsx`）只提供明暗模式和内置主题（Lody/Claude），不再提供新建、编辑、删除自定义主题的入口；Host 上已保存的自定义主题仍由 `desktop/app/appearance.ts` 渲染。

## 图标

`desktop/ui/icon.tsx` 的 Icon 用 Canvas/Path2D 缩放生成路径，不在应用运行时引入 lucide-react。生成数据保留原导出名称（含别名）、viewbox size、有序 paths 和 fill 标记；许可证在 `desktop/app/Lucide-LICENSE`。生成器扫描 `web/` 的导入；只有桌面用到的图标写进 `desktop/app/lucide-icon-names.json` 再重新生成，缺失的名字会让 `nsh check` 报类型错误（`IconName` 来自生成的 JSON）。

## 字体

字体放 `desktop/fonts/`，并在 `desktop/app/fonts.ts` 静态导入注册，入口 `desktop/App.tsx` 导入该模块，独立 UI fixture 同样导入。应用内资产布局见 `desktop/fonts/README.md`。

Inter、JetBrains Mono 的字体来自根依赖，与 Web 字体对应；具体字重、依赖版本和 OFL 许可证见 `desktop/fonts/README.md`，注册回归见 `desktop/tests/fonts.test.ts`。

nsh 0.6.1 解析 `cssVars` 中的字体 token 时只保留第一项。需要回退栈的桌面标题使用 `desktop/app/appearance.ts` 的 `displayFontFamily()` 作为 inline `fontFamily`，不要用 `token("font-display")` 读取回退栈。

### 已知问题：macOS 上 nsh 文字比 Tauri/WebUI 粗

这是 nsh 的渲染行为，不是字体选错或字重解析错误（2026-11-20 确认，nsh 0.6.1）。

- 主因：`nsh-platform-macos-0.6.1/src/text/raster.rs` 的 `paint_into` 写死了 `set_allows_font_smoothing(true)` 和 `set_should_smooth_fonts(true)`，macOS font smoothing 会加粗笔画。Tauri/WebUI 的 `web/index.css` 用了 `-webkit-font-smoothing: antialiased`，等于关闭它。实测开 smoothing 的 400 看起来接近关 smoothing 的 500；nsh 没有开关，App 层改不了。
- 次因：字体本身缺少某档字重时，CoreText 会就近选字面。nsh 的 `family_font` 用 family + `kCTFontWeightTrait`（AppKit `NSFontWeight*`）解析。例如 `HarmonyOS Sans SC` 只有 Thin/Light/Regular/Medium/Bold/Black，`font-semibold`（600 → `NSFontWeightSemibold`）会拿到 Bold；PingFang SC 有 Semibold，不受影响。`desktop/` 里有大量 `font-medium`/`font-semibold`，两者叠加后更明显。
- 400/500 解析正确：Regular → Regular，Medium → Medium。
- 处理方向（未实施）：向 nsh 上游提 issue/PR，增加关闭 font smoothing 的选项；短期可在本仓库用 `[patch.crates-io]` 修补 nsh。不要靠整体降低 `desktop/` 字重来规避，否则会和 WebUI 字重不一致。

## i18n

桌面端和 WebUI 都用 `app/shell/i18n.ts` 连接 nsh 与纯 TS 翻译层 `shared/i18n/translate.ts`。翻译键从 `shared/i18n/resources/en-US.ts` 推导，中文缺失时用英文。共享导入边界见[目录与边界](./directory-structure.md#状态和共享代码)。

启动用 `initializeI18n(storedLocale?)`，切换用 `setAppLocale`，显示用响应式 `t`/`appLocale`。适配同时调用 nsh/i18n 的 setLocale。语言解析由 `shared/i18n/locale-types.ts` 负责，不支持的语言回退英语。

`t(key, values?)` 将 `{{name}}` 一次替换为字面值，不做 HTML 转义，也不再次解释插入的内容。传入数字 `count` 时先查 `_zero`（若为 0）再查本语言的复数后缀，然后查原键；英语的 `1`/`-1` 用 `_one`，中文和其余数量用 `_other`。不依赖 `Intl.PluralRules`。`app/tests/i18n.test.ts` 覆盖切换语言、英文回退、插值和复数。
