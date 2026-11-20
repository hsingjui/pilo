# 基础组件

## 组件入口

组件清单以 `desktop/ui/` 和 `desktop/ui/README.md` 为准。接口以组件源码和 `nsh/base` 类型为准；完整交互例子在 `desktop/tests/` 的 ui fixture 与对应测试中。

## 组件规则

组件行为与组合示例见 `desktop/ui/README.md`。

- 一个 kebab-case TSX 文件一个具名组件，逐文件导入。例如在 app 层使用 `import { Button } from "../ui/button"`；不使用 React 组件入口。
- 封装 `nsh/base` 行为，采用原生 props（`class`、`onPress`），不套用 React/DOM 的 `className` 或 `asChild`。
- 调用者持有业务状态、文案与生命周期；基础组件只处理原生行为和外观。状态使用 nsh signal，见 `desktop/tests/ui-tabs-fixture.tsx`。
- 外观沿用共享主题 token；复合样式和主题切换方式见[主题与资源](./theme-and-assets.md#theme-token)。
- `transition-[opacity,background-color]` 在 nsh 会报 `unknown class`。需要同时过渡这两个属性时，用 `style={{ transitionProperty: "opacity, background-color" }}`，时长仍可用 `duration-100` 等类名。
- 图标作为 children 组合；未标注的 Icon 为装饰，纯图标控件需要控件可读名称。前景色继承实现见 `desktop/ui/foreground.ts`、`desktop/ui/icon.tsx`。

通用可访问性验收以[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)为准：键盘焦点、弹层关闭后恢复焦点、可读名称、窄窗口可用性均要实际交互验证。

## 菜单宽度与行间距

- `desktop/ui/menu.tsx` 的 `menuPopupClass` 默认最小宽度为 220 pt。只加 `popupClass="w-…"` 不会清掉这个下限。短操作菜单需要按内容收宽时，不另设固定宽度，用 `popupStyle={{ minWidth: 0 }}` 覆盖下限；带路径、描述或搜索框的菜单按内容需要保留宽度。
- 普通操作不需要勾选位时，在 `MenuItem` 上设置 `indicatorClass="hidden"`。默认的 `opacity-0` 只让勾选图标不可见，仍会占位；单选、多选项保留勾选状态和可见标记。
- nsh 的弹层内部有自己的滚动容器；在弹层 `popupClass` 或 `popupStyle` 上设 `gap` 不会给选项行留缝。需要隔开相邻高亮背景时，把 `gap` 放在直接承载菜单项的 `View` 上。会话菜单的 `⋯` 和右键入口共用同一组选项，行间距为 4 pt，见 `desktop/app/sidebar-session-row.tsx`。
- 在原生窗口复核：短标签不应留下空勾选槽，最长标签（含确认态）不应换行或裁切，相邻行高亮不应相接。仅检查类名不能确认实际宽度或间距。

## 下拉选择

- 普通单选用 `desktop/ui/select.tsx`。字体选择需要搜索、自定义名称和预览，保留 `Popover` + `Command`，触发器复用 `desktop/ui/select-trigger.tsx`。
- `Select` 和 `Command` 的 `listClass` 作用在外层滚动容器，而不是内部虚拟列表的行容器。用 `selectItemSpacing()` 给 `itemStyle` 加行间距；不要在 `listClass` 上加 `gap` 来隔开高亮背景。
- 普通 `Select` 的原生弹层跟随触发器宽度，默认从下方展开，空间不足时可向上翻转，不覆盖触发器。字体弹层通过 `onLayout` 读取触发器宽度。先约束触发器宽度，给箭头或勾选标记留空间，长标签采用单行截断。

## Fixture 模式

`desktop/tests/ui-button-fixture.tsx` 独立 mount 使用组件的应用，`desktop/tests/ui-button.test.tsx` 用 nsh/test 打开它并操作。新增组件沿用这一 fixture + test 模式；验证目标与测试交付节奏见[质量与验证](./quality-guidelines.md)。

ToastManager 的定时推进、暂停、dismiss、cleanup，以及 Scrollbar 与 Scroll/List ref 的连接方式，以 `desktop/ui/README.md` 及 `desktop/tests/ui-toast-fixture.tsx`、`desktop/tests/ui-scrollbar-fixture.tsx` 为准。
