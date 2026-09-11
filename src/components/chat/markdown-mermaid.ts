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

const MERMAID_LIGHT_THEME_VARIABLES = {
	background: "#ffffff",
	mainBkg: "#f7f8fa",
	secondaryColor: "#eef0f3",
	tertiaryColor: "#f0f1f4",
	primaryColor: "#eef0f3",
	primaryBorderColor: "#5b8def",
	primaryTextColor: "#1a1b1e",
	secondaryTextColor: "#1a1b1e",
	tertiaryTextColor: "#1a1b1e",
	lineColor: "#6b7280",
	textColor: "#1a1b1e",
	titleColor: "#1a1b1e",
	defaultLinkColor: "#6b7280",
	edgeLabelBackground: "#ffffff",
	nodeBorder: "#5b8def",
	clusterBkg: "#f7f8fa",
	clusterBorder: "#d5d8df",
};

const MERMAID_DARK_THEME_VARIABLES = {
	background: "#101010",
	mainBkg: "#161616",
	secondaryColor: "#232323",
	tertiaryColor: "#282828",
	primaryColor: "#232323",
	primaryBorderColor: "#ffc799",
	primaryTextColor: "#ffffff",
	secondaryTextColor: "#ffffff",
	tertiaryTextColor: "#ffffff",
	lineColor: "#a0a0a0",
	textColor: "#ffffff",
	titleColor: "#ffffff",
	defaultLinkColor: "#a0a0a0",
	edgeLabelBackground: "#101010",
	nodeBorder: "#ffc799",
	clusterBkg: "#161616",
	clusterBorder: "#282828",
};

export function createMarkdownMermaidConfig(
	theme: MarkdownTheme,
): MermaidConfig {
	return {
		...MERMAID_BASE_CONFIG,
		darkMode: theme === "dark",
		themeVariables:
			theme === "dark"
				? { ...MERMAID_DARK_THEME_VARIABLES }
				: { ...MERMAID_LIGHT_THEME_VARIABLES },
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
