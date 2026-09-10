import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_CYCLE_ORDER: readonly Theme[] = ["light", "dark", "system"];

export function nextCycledTheme(current: Theme): Theme {
	const index = THEME_CYCLE_ORDER.indexOf(current);
	return THEME_CYCLE_ORDER[(index + 1) % THEME_CYCLE_ORDER.length];
}

type ThemeProviderState = {
	theme: Theme;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState>({
	theme: "system",
	resolvedTheme: "light",
	setTheme: () => null,
});

const getSystemTheme = (): ResolvedTheme =>
	window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function parseStoredTheme(value: string | null): Theme | null {
	return value === "dark" || value === "light" || value === "system"
		? value
		: null;
}

export function ThemeProvider({
	children,
	defaultTheme = "system",
	storageKey = "pilo-ui-theme",
}: {
	children: React.ReactNode;
	defaultTheme?: Theme;
	storageKey?: string;
}) {
	const [theme, setStoredTheme] = useState<Theme>(
		() => parseStoredTheme(localStorage.getItem(storageKey)) ?? defaultTheme,
	);
	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

	const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setSystemTheme(getSystemTheme());
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	useLayoutEffect(() => {
		const root = window.document.documentElement;
		root.classList.remove("light", "dark");
		root.classList.add(resolvedTheme);
		root.style.colorScheme = theme === "system" ? "light dark" : resolvedTheme;
	}, [resolvedTheme, theme]);

	const setTheme = useCallback(
		(nextTheme: Theme) => {
			localStorage.setItem(storageKey, nextTheme);
			setStoredTheme(nextTheme);
		},
		[storageKey],
	);

	const value = useMemo(
		() => ({ theme, resolvedTheme, setTheme }),
		[theme, resolvedTheme, setTheme],
	);

	return (
		<ThemeProviderContext.Provider value={value}>
			{children}
		</ThemeProviderContext.Provider>
	);
}

export const useTheme = () => useContext(ThemeProviderContext);

export const useResolvedTheme = (): ResolvedTheme => useTheme().resolvedTheme;
