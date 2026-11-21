import { Text, View, mount, setTheme, signal, token, type Tokens } from "nsh";
import { Button } from "nsh/base";
import {
	createThemeTokenCatalog,
	isColorKind,
	nativeFontFamily,
	parseThemeColor,
	parseThemeLength,
	resolveCustomTheme,
	validateCustomThemeTokens,
	type CustomThemeTokens,
} from "@shared/theme-tokens";
import lody from "../theme.json";

const catalog = createThemeTokenCatalog(lody.cssVars);

// 每种接受的颜色写法各占一个颜色 token，nsh 读出的值必须与共享解析一致。
export const custom = {
	theme: {
		"pilo-bubble-radius": "1.5rem",
		"pilo-code-font-size": "13px",
		"font-mono": "'Fira Code', ui-monospace, monospace",
		"z-tooltip": "95",
	},
	light: {
		primary: "#c2512e",
		ring: "#abc",
		"pilo-composer-border": "#12abEF80",
		border: "rgb(255 0 128)",
		"pilo-user-bubble-bg": "rgba(255, 0, 128, 0.5)",
		"pilo-user-bubble-border": "rgb(100% 0% 50% / 50%)",
		popover: "hsl(120deg 100% 25%)",
		"pilo-sidebar-border-color": "hsla(240, 100%, 50%, 0.25)",
		"pilo-mobile-selected-background": "hsl(14 61.7% 47% / 0.1)",
		"pilo-composer-background": "transparent",
	},
	dark: { primary: "hsl(225 7.1% 11%)" },
} satisfies CustomThemeTokens;

const status = signal("idle");

function mismatches(appearance: "light" | "dark"): string[] {
	const expected: Record<string, string> = {
		...custom.theme,
		...custom.light,
		...(appearance === "dark" ? custom.dark : {}),
	};
	return Object.entries(expected).flatMap(([name, value]) => {
		const kind = catalog.get(name);
		const actual = token(name as keyof Tokens);
		const want =
			kind !== undefined && isColorKind(kind)
				? parseThemeColor(value)
				: kind === "length"
					? parseThemeLength(value)
					: kind === "number"
						? Number(value)
						: nativeFontFamily(value);
		return actual === want ? [] : [`${name}=${String(actual)}≠${String(want)}`];
	});
}

function check(appearance: "light" | "dark") {
	return () => {
		const wrong = mismatches(appearance);
		status.set(wrong.length ? wrong.join("; ") : `${appearance} matches`);
	};
}

mount(() => (
	<View class="flex-1 bg-background" testID="surface">
		<Text testID="status">{status}</Text>
		<Button
			onPress={() => {
				const result = validateCustomThemeTokens(custom, catalog);
				if (!result.ok) return status.set(JSON.stringify(result.issues));
				setTheme({ cssVars: resolveCustomTheme(lody.cssVars, result.tokens) });
				status.set("applied");
			}}
		>
			<Text>Apply custom</Text>
		</Button>
		<Button onPress={check("light")}>
			<Text>Check light</Text>
		</Button>
		<Button onPress={check("dark")}>
			<Text>Check dark</Text>
		</Button>
		<Button
			onPress={() => {
				const result = validateCustomThemeTokens(
					{ light: { primary: "#c2512e80" } },
					catalog,
				);
				if (result.ok) {
					setTheme({
						cssVars: resolveCustomTheme(lody.cssVars, result.tokens),
					});
					status.set("invalid theme applied");
				} else status.set(`rejected ${result.issues[0].code}`);
			}}
		>
			<Text>Apply invalid</Text>
		</Button>
	</View>
));
