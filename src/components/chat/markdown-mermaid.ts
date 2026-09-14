import type { MermaidConfig } from "mermaid";
import type { DiagramPlugin } from "streamdown";
import mermaidRuntimeUrl from "mermaid/dist/mermaid.min.js?url";

export type MarkdownTheme = "light" | "dark";

const MERMAID_FONT_FAMILY =
	'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const MERMAID_BASE_CONFIG = {
	fontFamily: MERMAID_FONT_FAMILY,
	securityLevel: "strict",
	startOnLoad: false,
	suppressErrorRendering: true,
	theme: "base",
} satisfies MermaidConfig;

/*
 * Mermaid 主题变量不写死颜色：直接读 CSS token，主题切换时随 token 一起变。
 * token 是空格分隔的 HSL 三元组，这里转成 khroma（mermaid 内部）能解析的逗号语法。
 */
const MERMAID_TOKEN_VARIABLES = {
	background: "--background",
	mainBkg: "--card",
	secondaryColor: "--secondary",
	tertiaryColor: "--hover",
	primaryColor: "--secondary",
	primaryBorderColor: "--ring",
	primaryTextColor: "--foreground",
	secondaryTextColor: "--foreground",
	tertiaryTextColor: "--foreground",
	lineColor: "--muted-foreground",
	textColor: "--foreground",
	titleColor: "--foreground",
	defaultLinkColor: "--muted-foreground",
	edgeLabelBackground: "--background",
	nodeBorder: "--ring",
	clusterBkg: "--card",
	clusterBorder: "--sidebar-border",
};

function readMermaidThemeVariables(): Record<string, string> {
	const tokens = getComputedStyle(document.documentElement);
	const variables: Record<string, string> = {};
	for (const [key, token] of Object.entries(MERMAID_TOKEN_VARIABLES)) {
		const value = tokens.getPropertyValue(token).trim();
		if (value) variables[key] = `hsl(${value.split(/\s+/).join(", ")})`;
	}
	return variables;
}

export function createMarkdownMermaidConfig(
	theme: MarkdownTheme,
): MermaidConfig {
	return {
		...MERMAID_BASE_CONFIG,
		darkMode: theme === "dark",
		themeVariables: readMermaidThemeVariables(),
	};
}

type MermaidRuntime = (typeof import("mermaid"))["default"];

function getGlobalMermaid() {
	return (globalThis as typeof globalThis & { mermaid?: MermaidRuntime })
		.mermaid;
}

export function createMarkdownMermaidPlugin(): DiagramPlugin {
	let runtimePromise: Promise<MermaidRuntime> | null = null;
	let currentConfig: MermaidConfig = createMarkdownMermaidConfig("light");

	const loadRuntime = () => {
		const loaded = getGlobalMermaid();
		if (loaded) return Promise.resolve(loaded);

		runtimePromise ??= new Promise<MermaidRuntime>((resolve, reject) => {
			const script = document.createElement("script");
			script.src = mermaidRuntimeUrl;
			script.async = true;
			script.dataset.piloMermaidRuntime = "true";
			script.addEventListener("load", () => {
				const runtime = getGlobalMermaid();
				if (runtime) resolve(runtime);
				else reject(new Error("Mermaid runtime loaded without global export"));
			});
			script.addEventListener("error", () => {
				reject(new Error("Failed to load Mermaid runtime"));
			});
			document.head.append(script);
		}).catch((error) => {
			runtimePromise = null;
			throw error;
		});
		return runtimePromise;
	};

	return {
		name: "mermaid",
		type: "diagram",
		language: "mermaid",
		getMermaid: (config?: MermaidConfig) => {
			if (config) currentConfig = { ...MERMAID_BASE_CONFIG, ...config };
			return {
				initialize: (nextConfig: MermaidConfig) => {
					currentConfig = { ...MERMAID_BASE_CONFIG, ...nextConfig };
				},
				render: async (id: string, source: string) => {
					const runtime = await loadRuntime();
					runtime.initialize(currentConfig);
					const { svg } = await runtime.render(id, source);
					return { svg };
				},
			};
		},
	};
}
