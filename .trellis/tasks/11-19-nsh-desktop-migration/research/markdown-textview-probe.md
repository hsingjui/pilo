# TextView Markdown 探测（M3.2）

探测应用：`desktop/tests/markdown-probe-fixture.tsx` + `markdown-probe.test.ts`（headless 与 `--target macos` 均运行过）。结论：nsh 0.6.0 `TextView` 的 `markdown` + `options={{ streaming: true }}` 直接覆盖 M3.2 的渲染需求，**不需要 JS streaming/parser 适配层**，也不需要 throttle。

## 已验证行为（macOS 真机截图 + 测试断言）

| 能力 | 结果 |
| --- | --- |
| 标题/段落/粗斜体/删除线/行内代码 | 原生排版（15pt/25.5pt 行高），无需自定义 |
| 无序/有序/任务列表 | marker、编号、checkbox（✓）均原生 |
| 代码块 | 原生语法高亮（keyword/string/comment 用主题 token）；`codeBlockActions={[{id:"copy"}]}` 内建复制，hover 浮现 ghost 按钮，剪贴板拿到代码文本 |
| 表格 | 表头底色 + 分隔线，原生 |
| 引用块 | 原生左边线样式 |
| 数学公式 | `$..$`/`$$..$$` 原生排版成真公式（不是源码），无需 KaTeX |
| 链接 | `links="report"` 时 `onLinkPress` 上报原始 url，不跳转，`openedUrls()` 为空；`file:///…` 与项目相对路径（`src/x.ts#L8`）原样上报，由 JS 侧解析 |
| 图片 | `data:` URI 正常渲染；`https:` 走真实网络加载，404 时留出空白位（log `warn image failed`），视图仍挂载 |
| 流式 | 逐 chunk 追加，未闭合语法按已闭合渲染（`**bo` 不显示字面星号）；600 个已渲染块旁一次 chunk apply ≤ ~36ms（event handler 到下一帧） |

## 测试 API 使用注意

- `id:x >> text:y` 无法深入 TextView 内部（其文本被平铺到 `app.texts()`）；但 `id:x >> label:y` 可以选中内部的 pressable（如 copy 按钮）。
- `text:` 选择器匹配整段文本 run，不匹配子串：`text:value4` 失败，`text:export const value4: number = 1;` 成功。
- 含图片的段落不向 `texts()` 暴露文本；断言放在相邻纯文本段落上。
- `--target macos` 下 `open()` 的 `network` stub 不拦截 TextView 图片加载（走真实 HTTP）；headless 只验证挂载，像素验证靠截图。
- 首个交互前先 `waitFor("text:streamed 0")` 之类就绪文本：真机目标上 `open` 返回后首帧可能尚未挂载，立即 `press` 会看到空屏。

## 缺口（记入验收风险）

1. **选择/复制任意文本无法自动化验证**：`selectable` + `onSelectionChange`/`selectedText({format})` API 存在，但 `drag`/`longPress` 不产生选区，`keyboard.down("shift")` 仅 headless/Linux 支持。需在 `nsh dev` 真窗口手动验收拖动选择与 ⌘C。
2. **文件链接无原生打开路径**：`openUrl` 拒绝 `file:`/`data:`/`javascript:`。M3.2 阶段项目文件链接只做上报+留待 M5 工作区标签；外链走 `openUrl`（`links="report"` 手动路由，不用 `links="open"`，以便拦截项目内链接）。
3. **项目图片需要 data: URI 桥接**：`readProjectImage(projectId, path)` 已桥接返回 bytes；转成 `data:` URI 喂给 `renderImage` 前的 img src 需要预取（markdown src 不支持异步解析），或先以 `renderImage` 自定义节点挂 loading 状态。错误提示与路径限制沿用 `chat-markdown-images.ts` 的纯函数。
4. **Mermaid**：按 M3.9 渲染为可复制的 `mermaid` 代码块（内建高亮按普通代码块处理，无图）。
5. **remote URL 图片**：测试环境无法覆盖真实加载成功路径（stub 不拦截）；404 表现为空白占位，无 alt 兜底文本。
6. **selection 嵌套**：`selectable` TextView 嵌在另一 `selectable` 视图内时外层持有选区——`chat-messages` 的行容器不要再加 `selectable`。
