import { languageForPath } from "@/lib/code-highlighter";

function hasUnsafePathCharacters(value: string): boolean {
	return Array.from(value).some((char) => {
		const code = char.charCodeAt(0);
		return char === "\\" || code < 32 || (code >= 127 && code <= 159);
	});
}

/** File links are user-activated previews/system opens, never browser navigation. */
export function resolveMarkdownFileUrl(value: string): string | null {
	if (
		!/^file:\/\//i.test(value) ||
		value.length > 4096 ||
		hasUnsafePathCharacters(value) ||
		/%(?:2f|5c)/i.test(value)
	)
		return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "file:" ||
			(url.hostname && url.hostname !== "localhost") ||
			/[?#]/.test(url.href)
		)
			return null;
		const path = decodeURIComponent(url.pathname);
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			hasUnsafePathCharacters(path) ||
			path.replace(/^\/[a-z]:\//i, "/").includes(":") ||
			path.endsWith("/")
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}

export function fileLinkPreviewKind(path: string): "markdown" | "code" | null {
	const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	const extension = name.split(".").at(-1) ?? "";
	if (["md", "markdown"].includes(extension)) return "markdown";
	// HTML stays in the browser; MDX is source, never evaluated.
	if (["html", "htm"].includes(extension)) return null;
	if (
		languageForPath(name) ||
		[
			"c",
			"h",
			"cc",
			"cpp",
			"cxx",
			"hpp",
			"cs",
			"java",
			"kt",
			"kts",
			"swift",
			"rb",
			"php",
			"vue",
			"svelte",
			"sql",
			"toml",
			"xml",
			"ini",
			"conf",
			"cfg",
			"txt",
			"log",
			"env",
			"gitignore",
			"dockerignore",
			"fish",
			"ps1",
			"psm1",
			"bat",
			"cmd",
			"pl",
			"r",
			"lua",
			"dart",
		].includes(extension) ||
		["dockerfile", "makefile", "license", "readme"].includes(name)
	)
		return "code";
	return null;
}

type LinkNode = {
	type?: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: LinkNode[];
};

function visitFileLinks(node: LinkNode) {
	const props = node.properties;
	if (
		node.tagName === "a" &&
		props &&
		typeof props.href === "string" &&
		/^file:/i.test(props.href)
	) {
		const url = resolveMarkdownFileUrl(props.href);
		const children = node.children ?? [];
		if (
			url &&
			children.every((child) => child.type === "text") &&
			resolveMarkdownFileUrl(
				children
					.map((child) => child.value ?? "")
					.join("")
					.trim(),
			) === url
		) {
			node.children = [
				{
					type: "text",
					value: decodeURIComponent(
						new URL(url).pathname.split("/").at(-1) ?? "",
					),
				},
			];
		}
		props["data-pilo-file-url"] = props.href;
		// Never let the WebView navigate to a file, even with modifier clicks.
		props.href = "https://pilo.invalid/file-link";
	}
	const children = node.children ?? [];
	for (const child of children) visitFileLinks(child);
	// Only file-only paragraphs/list items become attachment rows, never prose.
	if (
		(node.tagName === "p" || node.tagName === "li") &&
		children.every(
			(child) =>
				(child.type === "text" && !child.value?.trim()) ||
				child.tagName === "br" ||
				(child.tagName === "a" &&
					child.properties?.["data-pilo-file-url"] !== undefined),
		)
	) {
		for (const child of children) {
			if (child.properties?.["data-pilo-file-url"] !== undefined) {
				child.properties["data-pilo-file-layout"] = "standalone";
			}
		}
	}
}

/** After sanitize, preserve file targets for our component before harden blocks them. */
export function rehypeFileLinks() {
	return visitFileLinks;
}
