import type { RenderOptions } from "beautiful-mermaid";
import type { MermaidConfig } from "mermaid";
import type { DiagramPlugin } from "streamdown";

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

function mermaidConfigToRenderOptions(config: MermaidConfig): RenderOptions {
	const themeVariables = config.themeVariables ?? {};
	return {
		bg: themeVariables.background,
		fg: themeVariables.textColor,
		line: themeVariables.lineColor,
		accent: themeVariables.primaryBorderColor,
		muted: themeVariables.defaultLinkColor,
		surface: themeVariables.mainBkg,
		border: themeVariables.nodeBorder,
		font:
			typeof config.fontFamily === "string"
				? config.fontFamily
				: MERMAID_FONT_FAMILY,
		transparent: false,
	};
}

function escapeXml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderSourceFallback(source: string, options: RenderOptions) {
	const lines = source.split("\n").slice(0, 12);
	const fontSize = 12;
	const lineHeight = 18;
	const padding = 12;
	const longest = Math.max(
		1,
		...lines.map((line) => Math.min(line.length, 88)),
	);
	const width = Math.ceil(padding * 2 + longest * fontSize * 0.6);
	const height = padding * 2 + lines.length * lineHeight;
	const tspans = lines
		.map((line, index) => {
			const clipped = line.length > 88 ? `${line.slice(0, 88)}…` : line;
			return `<tspan x="${padding}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(clipped) || " "}</tspan>`;
		})
		.join("");

	return {
		svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${options.surface ?? options.bg ?? "#f8fafc"}" rx="6"/><text x="${padding}" y="${padding + fontSize}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${fontSize}" fill="${options.fg ?? "#0f172a"}">${tspans}</text></svg>`,
	};
}

type BeautifulMermaidRuntime = typeof import("beautiful-mermaid");

export function createMarkdownMermaidPlugin(): DiagramPlugin {
	let runtimePromise: Promise<BeautifulMermaidRuntime> | null = null;
	let runtimeUnavailable = false;
	let currentConfig: MermaidConfig = createMarkdownMermaidConfig("light");

	const loadRuntime = async () => {
		if (runtimeUnavailable) return null;
		runtimePromise ??= import("beautiful-mermaid");
		try {
			return await runtimePromise;
		} catch {
			runtimeUnavailable = true;
			runtimePromise = null;
			return null;
		}
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
				render: async (_id: string, source: string) => {
					const options = mermaidConfigToRenderOptions(currentConfig);
					const runtime = await loadRuntime();
					if (!runtime) return renderSourceFallback(source, options);
					try {
						return {
							svg: await runtime.renderMermaidSVGAsync(source, options),
						};
					} catch {
						return renderSourceFallback(source, options);
					}
				},
			};
		},
	};
}
