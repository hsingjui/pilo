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
	mainBkg: "#f8fafc",
	secondaryColor: "#eef6ff",
	tertiaryColor: "#f1f5f9",
	primaryColor: "#eef6ff",
	primaryBorderColor: "#60a5fa",
	primaryTextColor: "#0f172a",
	secondaryTextColor: "#0f172a",
	tertiaryTextColor: "#0f172a",
	lineColor: "#64748b",
	textColor: "#0f172a",
	titleColor: "#0f172a",
	defaultLinkColor: "#64748b",
	edgeLabelBackground: "#ffffff",
	nodeBorder: "#60a5fa",
	clusterBkg: "#f8fafc",
	clusterBorder: "#cbd5e1",
};

const MERMAID_DARK_THEME_VARIABLES = {
	background: "#0b1120",
	mainBkg: "#111827",
	secondaryColor: "#172033",
	tertiaryColor: "#1e293b",
	primaryColor: "#172033",
	primaryBorderColor: "#60a5fa",
	primaryTextColor: "#f8fafc",
	secondaryTextColor: "#f8fafc",
	tertiaryTextColor: "#f8fafc",
	lineColor: "#cbd5e1",
	textColor: "#e2e8f0",
	titleColor: "#f8fafc",
	defaultLinkColor: "#cbd5e1",
	edgeLabelBackground: "#0b1120",
	nodeBorder: "#60a5fa",
	clusterBkg: "#0f172a",
	clusterBorder: "#475569",
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
