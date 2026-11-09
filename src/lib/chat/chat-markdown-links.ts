import { languageForPath } from "@/lib/code-highlighter";
import type { WorkspaceLineRange } from "@/lib/project-workspace";

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

// Split at the first dot to avoid backtracking across dotted filenames.
const ROOT_FILE_LINE_REFERENCE =
	/^(?:[^/:.]*\.[^/:]+|dockerfile|makefile|license|readme):\d+(?::\d+)?(?:-\d+(?::\d+)?)?(?:#.*)?$/i;
const FILE_LINE_SUFFIX = /:(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?$/;
const FILE_LINE_FRAGMENT = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;

function markdownFileLocation(value: string): {
	path: string;
	lineRange?: WorkspaceLineRange;
} | null {
	if (value.length > 4096 || hasUnsafePathCharacters(value)) return null;
	const hash = value.indexOf("#");
	const path = hash < 0 ? value : value.slice(0, hash);
	const suffix = FILE_LINE_SUFFIX.exec(path);
	const fragment =
		hash < 0 ? null : FILE_LINE_FRAGMENT.exec(value.slice(hash + 1));
	const match = fragment ?? suffix;
	if (!match) return { path };
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 1 ||
		end < start
	)
		return null;
	return {
		path: suffix ? path.slice(0, suffix.index) : path,
		lineRange: { start, end },
	};
}

function relativeMarkdownFilePath(value: string): string | null {
	// A root-level filename with a line suffix is not a URL scheme.
	if (
		value.length > 4096 ||
		hasUnsafePathCharacters(value) ||
		(/^[a-z][a-z\d+.-]*:/i.test(value) && !ROOT_FILE_LINE_REFERENCE.test(value))
	)
		return null;
	const location = markdownFileLocation(value);
	if (!location) return null;
	let path: string;
	try {
		path = decodeURIComponent(location.path);
	} catch {
		return null;
	}
	if (
		!path ||
		path.startsWith("/") ||
		/[:?]/.test(path) ||
		/%(?:2f|5c)/i.test(value) ||
		hasUnsafePathCharacters(path) ||
		path.endsWith("/")
	)
		return null;
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "..") {
			if (!segments.length) return null;
			segments.pop();
		} else if (segment && segment !== ".") segments.push(segment);
	}
	return segments.length ? segments.join("/") : null;
}

function resolveRelativeProjectFileUrl(
	value: string,
	projectPath?: string,
): string | null {
	const relativePath = relativeMarkdownFilePath(value);
	if (!relativePath || !projectPath) return null;
	const root = projectPath
		.replace(/\\/g, "/")
		.replace(/^\/\/\?\/([a-z]:\/)/i, "$1");
	if (
		root.startsWith("//") ||
		(!root.startsWith("/") && !/^[a-z]:\//i.test(root))
	)
		return null;
	try {
		const encodedRoot = root
			.split("/")
			.map(encodeURIComponent)
			.join("/")
			.replace(/^([a-z])%3A\//i, "$1:/")
			.replace(/\/+$/, "");
		const encodedPath = relativePath
			.split("/")
			.map(encodeURIComponent)
			.join("/");
		return resolveMarkdownFileUrl(
			`file://${root.startsWith("/") ? "" : "/"}${encodedRoot}/${encodedPath}`,
		);
	} catch {
		return null;
	}
}

/** Resolve against the owning project; never send line/fragment syntax to IPC. */
export function resolveMarkdownFileLink(
	value: string,
	projectPath?: string,
): { url: string; lineRange?: WorkspaceLineRange } | null {
	const location = markdownFileLocation(value);
	if (!location) return null;
	const absolute = /^file:/i.test(value);
	// Absolute file URLs still reject arbitrary fragments and queries.
	const hash = value.indexOf("#");
	if (absolute && hash >= 0 && !FILE_LINE_FRAGMENT.test(value.slice(hash + 1)))
		return null;
	const url = absolute
		? resolveMarkdownFileUrl(location.lineRange ? location.path : value)
		: resolveRelativeProjectFileUrl(value, projectPath);
	if (!url) return null;
	const preview = fileLinkPreviewKind(
		decodeURIComponent(new URL(url).pathname),
	);
	if (absolute && location.lineRange && !preview) return null;
	return {
		url,
		...(preview && location.lineRange ? { lineRange: location.lineRange } : {}),
	};
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
		(/^file:/i.test(props.href) ||
			(Boolean(props.href) && !/^(?:[a-z][a-z\d+.-]*:|[/#])/i.test(props.href)))
	) {
		const target = /^file:/i.test(props.href)
			? resolveMarkdownFileLink(props.href)
			: null;
		const children = node.children ?? [];
		const labelTarget =
			target && children.every((child) => child.type === "text")
				? resolveMarkdownFileLink(
						children
							.map((child) => child.value ?? "")
							.join("")
							.trim(),
					)
				: null;
		if (
			target &&
			labelTarget &&
			target.url === labelTarget.url &&
			target.lineRange?.start === labelTarget.lineRange?.start &&
			target.lineRange?.end === labelTarget.lineRange?.end
		) {
			const location = target.lineRange;
			const suffix = location
				? `:${location.start}${location.end === location.start ? "" : `-${location.end}`}`
				: "";
			node.children = [
				{
					type: "text",
					value:
						decodeURIComponent(
							new URL(target.url).pathname.split("/").at(-1) ?? "",
						) + suffix,
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

/** Preserve root-level `file.ts:line[-line]` links through protocol sanitization. */
export function rehypeRelativeFileLinks() {
	return function visit(node: LinkNode) {
		const props = node.properties;
		if (
			node.tagName === "a" &&
			props &&
			typeof props.href === "string" &&
			relativeMarkdownFilePath(props.href) !== null &&
			ROOT_FILE_LINE_REFERENCE.test(props.href)
		)
			props.href = `./${props.href}`;
		for (const child of node.children ?? []) visit(child);
	};
}

/** After sanitize, preserve file targets for our component before harden blocks them. */
export function rehypeFileLinks() {
	return visitFileLinks;
}
