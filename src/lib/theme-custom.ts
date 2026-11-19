import type { CustomThemeTokens } from "./theme-tokens";
import { readCustomThemeTokens } from "./theme-web";

/**
 * 自定义主题族（data-theme-family="custom"）的用户 CSS 覆盖层。
 *
 * 用户直接编写 CSS，经 ThemeProvider 以 <style> 元素（textContent 写入，
 * 无 </style> 逃逸问题）注入 <head>，仅在 custom 族下生效，切走即清空。
 * index.html 的 boot 脚本会同步注入同一份 CSS，避免启动闪烁。
 */

/** 注入用 <style> 元素 id，boot 脚本与 ThemeProvider 共用同一元素。 */
export const CUSTOM_THEME_STYLE_ID = "pilo-custom-theme-css";

/** 设置页占位模板：教学注释 + 常用入口，全部注释掉，不影响渲染。 */
export const CUSTOM_CSS_PLACEHOLDER = `/*
 * 在这里编写 CSS 并命名保存，主题会加入「主题风格」列表并应用。
 *
 * Lody、Claude 和自定义主题共用同一套令牌，没有内置主题专属样式。
 * 颜色令牌是 HSL 三元组（不带 hsl()），例如：
 *
 * :root {
 *   --primary: 15.9 62.4% 59.6%;
 *   --pilo-bubble-radius: 1.25rem;
 *   --pilo-mobile-bubble-radius: 1rem;
 *   --pilo-button-height: 36px;
 *   --pilo-mobile-button-height: 48px;
 *   --pilo-field-height: 36px;
 *   --pilo-mobile-field-height: 48px;
 *   --pilo-sidebar-margin: 0;
 *   --pilo-sidebar-radius: 0;
 *   --pilo-sidebar-border-width: 0 1px 0 0;
 *   --pilo-sidebar-width: 100%;
 *   --pilo-sidebar-height: 100%;
 *   --pilo-sidebar-padding: 0.5rem;
 *   --pilo-sidebar-shadow: none;
 * }
 *
 * .dark {
 *   --primary: 15.9 62.4% 59.6%;
 * }
 *
 * 布局入口：.pilo-sidebar-surface / .pilo-mobile-sidebar
 * 选中状态：.pilo-sidebar-selected / .pilo-mobile-selected
 * 输入框：.pilo-composer-surface / .pilo-field
 * 浮层：.pilo-floating-surface / .pilo-tooltip
 * 菜单：.pilo-menu-surface / .pilo-menu-item / .pilo-select-item
 *
 * 直接在 :root 内覆盖令牌即可，无需修改主题标识或复制组件规则。
 * 尺寸令牌 --pilo-* 控制桌面端，对应 --pilo-mobile-* 独立控制移动端。
 * 移动端未填写时保留默认值；颜色、阴影和字体仍共享。
 * 全部令牌见 src/styles/lody-theme.css 和 claude-theme.css。
 * 修改明暗配色时分别使用 :root 和 :root.dark。
 * 完整入口与说明见 docs/THEMES.md。
 */`;

export type SavedCustomTheme = {
	name: string;
	css: string;
	tokens: CustomThemeTokens;
};

export function isThemeCustomCss(value: unknown): value is string {
	return typeof value === "string";
}

export function readSavedCustomThemes(value: unknown): SavedCustomTheme[] {
	if (!Array.isArray(value)) return [];
	const themes = new Map<string, SavedCustomTheme>();
	for (const entry of value) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("name" in entry) ||
			typeof entry.name !== "string" ||
			("css" in entry && typeof entry.css !== "string")
		)
			continue;
		const name = entry.name.trim();
		if (name)
			themes.set(name, {
				name,
				css: "css" in entry ? (entry.css as string) : "",
				tokens: readCustomThemeTokens(
					"tokens" in entry ? entry.tokens : undefined,
				),
			});
	}
	return [...themes.values()];
}
