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
| `src/styles/lody-theme.css`、`src/styles/claude-theme.css` | `desktop/theme.json`、`desktop/claude-theme.json`、`src/lib/theme-web-map.json` |
| `src/` 内具名 lucide-react 图标导入及依赖中的图标数据      | `desktop/app/lucide-icons.json`                                                 |

## Theme token

`cssVars` 是 nsh 可识别的颜色、数值/长度、字体族；用 `token()` 或 token class。`styleVars` 保留复合阴影、动效、简写和依赖布局的计算，不传给 token API；通过 `desktop/ui/theme-style.ts` 的 `styleVar()` 取值，再传 inline style。

切换族时成对调用 `setTheme({ cssVars: theme.cssVars })` 和 `setStyleTheme(theme.styleVars)`；恢复默认 Lody 时两者均传 null。亮暗取对应 appearance 的值。参考 `desktop/tests/ui-gallery-fixture.tsx`，不要只换颜色漏掉阴影。

生成器解析绝对长度计算；源主题没有通用 radius，组件使用命名 Pilo radius token。自定义主题使用 `src/lib/theme-tokens.ts` 的 catalog、`validateCustomThemeTokens`、`resolveCustomTheme` 共用纯逻辑，不接受任意 CSS 选择器；格式为 theme/light/dark token 表，校验失败不应用。详细类型与限制见 `desktop/README.md`，原生解析回归见 `desktop/tests/custom-theme.test.ts`。

## 图标

`desktop/ui/icon.tsx` 的 Icon 用 Canvas/Path2D 缩放生成路径，不在应用运行时引入 lucide-react。生成数据保留原导出名称（含别名）、viewbox size、有序 paths 和 fill 标记；许可证在 `desktop/app/Lucide-LICENSE`。生成器扫描共享 src 的导入，不会因为只在 desktop 写一个新 name 就自动生成。

## 字体

字体放 `desktop/fonts/`，并在 `desktop/app/fonts.ts` 静态导入注册，入口 `desktop/App.tsx` 导入该模块，独立 UI fixture 同样导入。应用内资产布局见 `desktop/fonts/README.md`。

Inter、JetBrains Mono 的字体来自根依赖，与 Web 字体对应；具体字重、依赖版本和 OFL 许可证见 `desktop/fonts/README.md`，注册回归见 `desktop/tests/fonts.test.ts`。

## i18n

`desktop/app/i18n.ts` 复用 `src/i18n/instance.ts` 和 `src/i18n/options.ts`；资源是 `src/i18n/resources/en-US.ts`、`src/i18n/resources/zh-CN.ts`。共享导入边界见[目录与边界](./directory-structure.md#状态和共享代码)。

启动用 `initializeI18n(storedLocale?)`，切换用 `setAppLocale`，显示用响应式 `t`/`appLocale`。适配同时调用 nsh/i18n 的 setLocale。语言解析由 `src/i18n/locale-types.ts` 负责，不支持的语言回退英语。

复数实现不以 `Intl.PluralRules` 为前提：`desktop/tests/i18n.test.ts` 的 without Intl.PluralRules 测试覆盖现有 i18next 路径及 `_one`/`_other`、count 插值的英中文行为。复数测试使用独立测试资源；新增行为的验证遵循[质量与验证](./quality-guidelines.md)。
