import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { i18n } from "@/i18n";
import { listenRuntimeEvents } from "@/lib/api/pi-runtime";
import { CUSTOM_THEME_STYLE_ID } from "@/lib/theme-custom";
import {
	compatibleThemeUpdate,
	customThemeCss,
	legacyThemeInitial,
	normalizeThemeSettings,
	supportsThemeTokens,
} from "@/lib/theme-compat";
import {
	readCachedTheme,
	THEME_CACHE_KEY,
	type Theme,
	type ThemeSettings,
	type ThemeSettingsUpdate,
} from "@/lib/theme-settings";

export type { Theme, ThemeFamily } from "@/lib/theme-settings";
export type ResolvedTheme = "light" | "dark";

const DESKTOP_RUNTIME =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const THEME_CYCLE_ORDER: readonly Theme[] = ["light", "dark", "system"];

export function nextCycledTheme(current: Theme): Theme {
	const index = THEME_CYCLE_ORDER.indexOf(current);
	return THEME_CYCLE_ORDER[(index + 1) % THEME_CYCLE_ORDER.length];
}

type ThemeProviderState = ThemeSettings & {
	supportsThemeTokens: boolean;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
	applyThemeSettings: (settings: ThemeSettings) => void;
	updateThemeSettings: (update: ThemeSettingsUpdate) => void;
	bindThemeWriter: (
		writer: (update: ThemeSettingsUpdate) => Promise<ThemeSettings>,
	) => () => void;
};

const ThemeProviderContext = createContext<ThemeProviderState>({
	revision: 0,
	theme: "system",
	themeFamily: "lody",
	themeCustomCss: "",
	themeCustomTokens: {},
	supportsThemeTokens: false,
	themeCustomName: "",
	savedCustomThemes: [],
	resolvedTheme: "light",
	setTheme: () => {},
	applyThemeSettings: () => {},
	updateThemeSettings: () => {},
	bindThemeWriter: () => () => {},
});

const getSystemTheme = (): ResolvedTheme =>
	window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export function ThemeProvider({
	children,
	defaultTheme = "system",
	storageKey = "pilo-ui-theme",
	familyStorageKey = "pilo-ui-theme-family",
}: {
	children: React.ReactNode;
	defaultTheme?: Theme;
	storageKey?: string;
	familyStorageKey?: string;
}) {
	const [settings, setSettings] = useState(() =>
		readCachedTheme(defaultTheme, storageKey, familyStorageKey),
	);
	const { theme, themeFamily, themeCustomTokens, themeCustomCss } = settings;
	const [tokenCapability, setTokenCapability] = useState(false);
	const tokenCapabilityRef = useRef(false);
	const initialSettingsRef = useRef(settings);
	const revisionRef = useRef(-1);
	const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
	const remoteWriterRef = useRef<
		((update: ThemeSettingsUpdate) => Promise<ThemeSettings>) | null
	>(null);
	const bindThemeWriter = useCallback(
		(writer: (update: ThemeSettingsUpdate) => Promise<ThemeSettings>) => {
			remoteWriterRef.current = writer;
			return () => {
				if (remoteWriterRef.current === writer) remoteWriterRef.current = null;
			};
		},
		[],
	);
	const applyThemeSettings = useCallback((next: ThemeSettings) => {
		if (next.revision <= revisionRef.current) return;
		revisionRef.current = next.revision;
		tokenCapabilityRef.current = supportsThemeTokens(next);
		setTokenCapability(tokenCapabilityRef.current);
		setSettings(normalizeThemeSettings(next));
	}, []);

	useEffect(() => {
		if (!DESKTOP_RUNTIME) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const refresh = async () => {
			const next = await invoke<ThemeSettings>("theme_settings_get", {
				initial: legacyThemeInitial(initialSettingsRef.current),
			});
			if (!disposed) applyThemeSettings(next);
		};
		const onVisible = () => {
			if (document.visibilityState === "visible")
				void refresh().catch(reportLoadError);
		};
		const reportLoadError = (error: unknown) => {
			if (!disposed)
				toast.error(i18n.t("settings.themeLoadFailed"), {
					description: String(error),
				});
		};
		void (async () => {
			const cleanup = await listenRuntimeEvents((event) => {
				if (!disposed && event.type === "theme_settings_changed")
					applyThemeSettings(event.settings);
			});
			if (disposed) {
				cleanup();
				return;
			}
			unlisten = cleanup;
			await refresh();
		})().catch(reportLoadError);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			disposed = true;
			unlisten?.();
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [applyThemeSettings]);

	useEffect(() => {
		try {
			const { themeCustomConversion: _conversion, ...cachedSettings } =
				settings;
			localStorage.setItem(
				THEME_CACHE_KEY,
				JSON.stringify({
					...cachedSettings,
					...(supportsThemeTokens(settings)
						? { themeCustomTokenCss: customThemeCss(settings) }
						: {}),
				}),
			);
			localStorage.setItem(storageKey, theme);
			localStorage.setItem(familyStorageKey, themeFamily);
		} catch {
			// Cache failure must not prevent the Host theme from being applied.
		}
	}, [settings, theme, themeFamily, storageKey, familyStorageKey]);

	useLayoutEffect(() => {
		let el = document.getElementById(CUSTOM_THEME_STYLE_ID);
		if (!el) {
			el = document.createElement("style");
			el.id = CUSTOM_THEME_STYLE_ID;
			document.head.appendChild(el);
		}
		el.textContent = customThemeCss(settings);
	}, [settings]);

	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

	const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

	// null = 尚未应用过主题（首次挂载不做过渡抑制）。
	const appliedThemeRef = useRef<string | null>(null);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setSystemTheme(getSystemTheme());
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") onChange();
		};
		onChange();
		media.addEventListener("change", onChange);
		window.addEventListener("pageshow", onChange);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			media.removeEventListener("change", onChange);
			window.removeEventListener("pageshow", onChange);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);

	useLayoutEffect(() => {
		const root = window.document.documentElement;
		// 主题翻转会让几乎所有元素的颜色/边框/阴影同时变化，任由过渡播放会整页拖影。
		// 先挂上禁用类、强制 reflow，翻转后在下一帧移除，让后续交互恢复过渡。
		const applied = `${themeFamily}:${resolvedTheme}:${themeFamily === "custom" ? (tokenCapability ? JSON.stringify(themeCustomTokens) : themeCustomCss) : ""}`;
		const switching =
			appliedThemeRef.current !== null && appliedThemeRef.current !== applied;
		appliedThemeRef.current = applied;

		if (switching) {
			root.classList.add("pilo-theme-switch");
			void document.body.offsetWidth;
		}

		root.classList.remove("light", "dark");
		root.classList.add(resolvedTheme);
		root.dataset.themeFamily = themeFamily;
		const colorScheme = resolvedTheme;
		root.style.colorScheme = colorScheme;
		document
			.querySelector('meta[name="color-scheme"]')
			?.setAttribute("content", colorScheme);

		// Explicitly update Android's system bars instead of relying on meta media queries.
		const background = getComputedStyle(root)
			.getPropertyValue("--background")
			.trim();
		const themeColor = `hsl(${background})`;
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute("content", themeColor);

		if (switching) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					root.classList.remove("pilo-theme-switch");
				});
			});
		}
	}, [
		resolvedTheme,
		themeFamily,
		themeCustomTokens,
		themeCustomCss,
		tokenCapability,
	]);

	const updateSettings = useCallback(
		(update: ThemeSettingsUpdate) => {
			if (!DESKTOP_RUNTIME && !remoteWriterRef.current) return;
			writeQueueRef.current = writeQueueRef.current
				.then(async () => {
					const payload = compatibleThemeUpdate(
						update,
						tokenCapabilityRef.current,
					);
					if (!DESKTOP_RUNTIME) {
						const writer = remoteWriterRef.current;
						if (writer) applyThemeSettings(await writer(payload));
						return;
					}
					// Initialize legacy desktop settings before the first edit, even if startup loading failed.
					await invoke<ThemeSettings>("theme_settings_get", {
						initial: legacyThemeInitial(initialSettingsRef.current),
					});
					const next = await invoke<ThemeSettings>("theme_settings_set", {
						update: payload,
					});
					applyThemeSettings(next);
				})
				.catch((error: unknown) => {
					toast.error(i18n.t("settings.themeSaveFailed"), {
						description: String(error),
					});
				});
		},
		[applyThemeSettings],
	);
	const setTheme = useCallback(
		(nextTheme: Theme) => updateSettings({ theme: nextTheme }),
		[updateSettings],
	);

	const value = useMemo(
		() => ({
			...settings,
			supportsThemeTokens: tokenCapability,
			resolvedTheme,
			setTheme,
			applyThemeSettings,
			updateThemeSettings: updateSettings,
			bindThemeWriter,
		}),
		[
			settings,
			tokenCapability,
			resolvedTheme,
			setTheme,
			applyThemeSettings,
			updateSettings,
			bindThemeWriter,
		],
	);

	return (
		<ThemeProviderContext.Provider value={value}>
			{children}
		</ThemeProviderContext.Provider>
	);
}

export const useTheme = () => useContext(ThemeProviderContext);

export const useResolvedTheme = (): ResolvedTheme => useTheme().resolvedTheme;
