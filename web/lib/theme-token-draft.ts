import type { CustomThemeTokens } from "@shared/theme-tokens";
import { isColorKind } from "@shared/theme-tokens";
import { CUSTOM_THEME_CATALOG } from "@shared/theme-web";

/**
 * 编辑器草稿形态：颜色 token 只按明暗两栏编辑，`theme` 里的颜色挪到 `light`
 * （`light` 本来也覆盖暗色）；非颜色 token 留在 `theme`。
 */
export function editableThemeTokens(
	tokens: CustomThemeTokens,
): CustomThemeTokens {
	const theme = { ...tokens.theme };
	const light = { ...tokens.light };
	for (const [token, value] of Object.entries(theme)) {
		const kind = CUSTOM_THEME_CATALOG.get(token);
		if (kind && isColorKind(kind)) {
			light[token] = value;
			delete theme[token];
		}
	}
	return { theme, light, dark: { ...tokens.dark } };
}

/** 草稿的稳定序列化：按 catalog 顺序取每个作用域的值，比较草稿与已存内容。 */
export function themeTokensKey(tokens: CustomThemeTokens): string {
	const editable = editableThemeTokens(tokens);
	return JSON.stringify(
		(["theme", "light", "dark"] as const).map((scope) =>
			[...CUSTOM_THEME_CATALOG.keys()].map(
				(token) => editable[scope]?.[token] ?? "",
			),
		),
	);
}
