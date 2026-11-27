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
- nsh 的弹层内部有自己的滚动容器；在弹层 `popupClass` 或 `popupStyle` 上设 `gap` 不会给选项行留缝。`app/ui/menu.tsx` 的 `Menu` 已默认用 `menuListSpacing()`（`Math.max(3, token("pilo-menu-item-gap"))`）包裹子项，`web/mobile-dropdown-menu.tsx` 也共用该间距；直接使用 `nsh/base` `ContextMenu` 或自定义 `Submenu` 弹层时，仍需把 `menuListSpacing()` 或 `gap-1` 放在直接承载菜单项的 `View` 上（如 `app/shell/sidebar-session-row.tsx`、`app/composer/composer-run-config.tsx`）。
- 在原生窗口复核：短标签不应留下空勾选槽，最长标签（含确认态）不应换行或裁切，相邻行高亮不应相接。仅检查类名不能确认实际宽度或间距。

## 下拉选择

- 普通单选用 `app/ui/select.tsx`。字体选择需要搜索、自定义名称和预览，保留 `Popover` + `Command`，触发器复用 `app/ui/select-trigger.tsx`。
- `Select` 和 `Command` 的 `listClass` 作用在外层 `Scroll` 滚动容器，而不是内部虚拟列表的行容器。用 `selectItemSpacing()` 给 `itemStyle` 加行间距；不要在 `listClass` 上加 `gap` 来隔开高亮背景，也**不要在 `listClass` 上加 `p-*` 内边距**（nsh 的 `Scroll` 会把内边距计入 `ScrollContent` 尺寸，导致即使选项全部渲染完也会出现滚动条）。外框留白放到 `popupClass`（无搜索框时）或 `listClass` 的 `m-*` 外边距上。
- 下拉列表统一通过 `selectListMaxHeight()`（默认上限 `SELECT_LIST_MAX_HEIGHT = 288`，窄高视口按视口 45% 收缩且不低于 160）限定最大高度：选项较少时自然贴合内容高度且无滚动条，选项较多时在限定高度内滚动。
- 普通 `Select` 的原生弹层跟随触发器宽度，默认从下方展开，空间不足时可向上翻转，不覆盖触发器。字体弹层通过 `onLayout` 读取触发器宽度。先约束触发器宽度，给箭头或勾选标记留空间，长标签采用单行截断。

## 控件高度与复用

- 同一行相邻的输入框、下拉和按钮必须同高。`Input`、`Select`/`SelectTrigger`、`NumberInput`（`desktop/ui/number-input.tsx`）默认高度为 `--pilo-field-height`（36 pt），`size="sm"` 时为 `--pilo-button-sm-height`（32 pt），与 `Button size="sm"` 一致。
- 设置页沿用 Tauri 的紧凑控件（`SETTINGS_CONTROL_CLASS = h-8`）：字段一律传 `size="sm"`，旁边的按钮用 `desktop/settings/layout.tsx` 的 `SETTINGS_ICON_BUTTON_CLASS` / `SETTINGS_TEXT_BUTTON_CLASS`；`SettingsSection` 标题栏的图标按钮用 `SETTINGS_HEADER_ICON_BUTTON_CLASS`（28 pt）。不要用 `style={{ height }}` 把按钮硬拉到字段高度。
- 数字输入用 `desktop/ui/number-input.tsx`，不要直接用 `nsh/base` 的 `NumberInput`（它没有自带外观）。弹窗右上角的关闭按钮用 `desktop/ui/dialog-close.tsx`。隐藏 `MenuItem` 前置勾选、改在行尾显示勾选时用 `desktop/ui/menu-check.tsx`。
- 设置里的 `Select` 和聊天里的 `Menu` 弹层外观不同是有意为之，与 WebUI 的 Select / DropdownMenu 对应，各自由主题 token（`pilo-select-*`、`pilo-menu-*`）控制，不要互相替换。

## Fixture 模式

`desktop/tests/ui-button-fixture.tsx` 独立 mount 使用组件的应用，`desktop/tests/ui-button.test.tsx` 用 nsh/test 打开它并操作。新增组件沿用这一 fixture + test 模式；验证目标与测试交付节奏见[质量与验证](./quality-guidelines.md)。

ToastManager 的定时推进、暂停、dismiss、cleanup，以及 Scrollbar 与 Scroll/List ref 的连接方式，以 `desktop/ui/README.md` 及 `desktop/tests/ui-toast-fixture.tsx`、`desktop/tests/ui-scrollbar-fixture.tsx` 为准。
