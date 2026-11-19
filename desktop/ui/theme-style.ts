import { colorScheme, signal } from "nsh";
import lody from "../theme.json";

type StyleName =
	| keyof typeof lody.styleVars.theme
	| keyof typeof lody.styleVars.light
	| keyof typeof lody.styleVars.dark;
export interface StyleVariables {
	theme?: Partial<Record<StyleName, string>>;
	light?: Partial<Record<StyleName, string>>;
	dark?: Partial<Record<StyleName, string>>;
}

const styles = signal<StyleVariables>(lody.styleVars);

export function setStyleTheme(value: StyleVariables | null) {
	styles.set(value ?? lody.styleVars);
}

export function styleVar(name: StyleName): string | undefined {
	const value = styles();
	return (
		(colorScheme() === "dark" ? value.dark?.[name] : undefined) ??
		value.light?.[name] ??
		value.theme?.[name]
	);
}
