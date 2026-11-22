import type { Project } from "@shared/api/projects-types";
import { resolveChatImageMimeType } from "@shared/chat/chat-submission";
import { workspaceFileKey } from "@shared/project-workspace";

/** The project a Markdown document belongs to: how its images are read. */
export type ChatProjectImageScope = {
	projectId: string;
	projectPath?: string;
	sessionKey: string;
	baseDirectory?: string;
	readImage?: (
		projectId: string,
		path: string,
	) => Promise<Uint8Array<ArrayBuffer>>;
};

/** Outside-project documents never gain access to their neighbouring system files. */
export function projectMarkdownImageScope(
	project: Pick<Project, "id" | "path">,
	filePath: string,
): ChatProjectImageScope | null {
	const root = workspaceFileKey(project.path).replace(/\/+$/, "");
	const path = workspaceFileKey(filePath);
	if (!path.startsWith(`${root}/`)) return null;
	const relative = path.slice(root.length + 1);
	if (!relative || relative.split("/").includes("..")) return null;
	return {
		projectId: project.id,
		sessionKey: filePath,
		baseDirectory: relative.split("/").slice(0, -1).join("/"),
	};
}

export type MarkdownImageSource =
	| { type: "external"; url: string }
	| { type: "project"; path: string; mimeType: string }
	| { type: "invalid" };

/** Markdown paths are project-relative, never browser-relative or system paths. */
export function resolveMarkdownImageSource(
	src?: string,
	baseDirectory?: string,
): MarkdownImageSource {
	if (!src) return { type: "invalid" };
	if (/^https?:\/\//i.test(src)) {
		try {
			const url = new URL(src);
			if (!url.username && !url.password)
				return { type: "external", url: url.href };
		} catch {
			// Fall through to the invalid-source state.
		}
		return { type: "invalid" };
	}
	let path: string;
	try {
		path = decodeURIComponent(src).replaceAll("\\", "/");
	} catch {
		return { type: "invalid" };
	}
	if (
		path.length > 4096 ||
		path.startsWith("/") ||
		/[:?#]/.test(path) ||
		Array.from(path).some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || (code >= 127 && code <= 159);
		})
	)
		return { type: "invalid" };
	const segments = path.split("/");
	if (baseDirectory === undefined && segments.includes(".."))
		return { type: "invalid" };
	const resolved = baseDirectory ? baseDirectory.split("/") : [];
	for (const segment of segments) {
		if (segment === "..") {
			if (!resolved.length) return { type: "invalid" };
			resolved.pop();
		} else if (segment && segment !== ".") resolved.push(segment);
	}
	path = resolved.join("/");
	const mimeType = resolveChatImageMimeType({ name: path, type: "" });
	return path && typeof mimeType === "string"
		? { type: "project", path, mimeType }
		: { type: "invalid" };
}

/** Resolves the suggested filename for saving a data/blob image; undefined for external URLs. */
export function lightboxDownloadName({
	url,
	name,
}: {
	url: string;
	name: string;
}): string | undefined {
	if (url.startsWith("blob:")) return name || "image";
	const inlineMimeType = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(url)?.[1];
	if (!inlineMimeType) return undefined;
	const mimeType = resolveChatImageMimeType({ name: "", type: inlineMimeType });
	if (!mimeType) return undefined;
	if (
		name.includes(".") &&
		resolveChatImageMimeType({ name, type: "" }) === mimeType
	)
		return name;
	// Pi can convert the image, so the download must use the result's format.
	return `${name.replace(/\.[^.]+$/, "") || "image"}.${mimeType.slice("image/".length)}`;
}

type ImageNode = {
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: ImageNode[];
};

/** Run after sanitization, before harden rebases relative URLs and removes `..`. */
export function rehypeProjectImages() {
	return (tree: ImageNode) => {
		function visit(node: ImageNode) {
			if (node.tagName === "img") {
				const props = node.properties ?? (node.properties = {});
				const src = typeof props.src === "string" ? props.src : "";
				if (resolveMarkdownImageSource(src).type !== "external") {
					props["data-pilo-image-src"] = src;
					// Only the custom image component consumes this sentinel; never fetch it.
					props.src = "https://pilo.invalid/project-image";
				}
			}
			for (const child of node.children ?? []) visit(child);
		}
		visit(tree);
	};
}
