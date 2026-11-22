import type { Project } from "@shared/api/projects-types";
import { resolveMarkdownImageSource } from "@shared/chat/chat-markdown-images";
import {
	fileLinkPreviewKind,
	resolveMarkdownFileLink,
} from "@shared/chat/chat-markdown-links";
import { MAX_CHAT_IMAGE_BYTES } from "@shared/chat/chat-submission";
import { fileBasename } from "@shared/chat/chat-tool-result";
import {
	workspaceFileKey,
	type WorkspaceFile,
} from "@shared/project-workspace";

import type { ChatMarkdownFileLink } from "../chat/chat-markdown";
import type { ChatImagePreview } from "../chat/chat-media-actions";
import type { WorkspaceStore } from "../state/workspace-store";
import type { AppToasts } from "./app-toasts";
import { t } from "./i18n";

export type OpenFileLinkClient = (
	projectId: string,
	url: string,
	preview: boolean,
) => Promise<WorkspaceFile | null>;

function decodeFileUrlPath(url: string): string {
	return decodeURIComponent(new URL(url).pathname).replace(
		/^\/([a-z]:\/)/i,
		"$1",
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

export function resolveProjectImageCandidate(
	projectPath: string,
	candidate: string,
) {
	const root = workspaceFileKey(projectPath).replace(/\/+$/, "");
	const path = workspaceFileKey(candidate.trim());
	const relative = path.startsWith(`${root}/`)
		? path.slice(root.length + 1)
		: path;
	// Tool paths are literal filesystem names, not URL-encoded Markdown sources.
	return resolveMarkdownImageSource(encodeURIComponent(relative));
}

export interface FileLinkOpenContext {
	project: () => Pick<Project, "id" | "path"> | null;
	workspace: WorkspaceStore;
	openFileLink?: OpenFileLinkClient;
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	openImage?: (image: ChatImagePreview) => void;
	toasts: AppToasts;
	onFileActivated?: () => void;
}

/** Opens a resolved Markdown file link in a workspace preview tab or the system app. */
export function openMarkdownFileLink(
	ctx: FileLinkOpenContext,
	link: ChatMarkdownFileLink,
): void {
	const project = ctx.project();
	if (!project) {
		ctx.toasts.show({ variant: "error", title: t("chat.fileLinkNoProject") });
		return;
	}
	let decodedPath: string;
	try {
		decodedPath = decodeFileUrlPath(link.url);
	} catch {
		ctx.toasts.show({ variant: "error", title: t("chat.fileLinkInvalid") });
		return;
	}
	const preview = fileLinkPreviewKind(decodedPath) !== null;
	if (preview) {
		const existing = ctx.workspace.findFile(project.id, decodedPath);
		if (existing) {
			ctx.workspace.selectFile(project.id, existing.path, link.lineRange);
			ctx.onFileActivated?.();
			return;
		}
	}
	if (!ctx.openFileLink) {
		ctx.toasts.show({
			variant: "error",
			title: t("file.workspaceUnavailable"),
		});
		return;
	}
	void ctx
		.openFileLink(project.id, link.url, preview)
		.then((file) => {
			if (!file) return;
			ctx.workspace.openFile(project.id, file, link.lineRange);
			ctx.onFileActivated?.();
		})
		.catch((error: unknown) => {
			ctx.toasts.show({
				variant: "error",
				title: t("chat.fileLinkOpenFailed"),
				description:
					error instanceof Error ? error.message : t("chat.fileLinkCheckPath"),
			});
		});
}

function toToolFileLinkInput(candidate: string): string {
	const trimmed = candidate.trim();
	if (!trimmed || /^file:/i.test(trimmed)) return trimmed;
	const normalized = trimmed.replaceAll("\\", "/");
	if (normalized.startsWith("/")) {
		const encoded = normalized
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		return `file://${encoded}`;
	}
	if (/^[a-z]:\//i.test(normalized)) {
		const [drive, ...rest] = normalized.split("/");
		const encoded = rest
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		return `file:///${drive}/${encoded}`;
	}
	return normalized
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/** Whether a tool-reported path can open as a project image or a workspace file link. */
export function canOpenToolFilePath(
	ctx: FileLinkOpenContext,
	candidate: string,
): boolean {
	const project = ctx.project();
	if (!project) return false;
	if (
		ctx.readProjectImage &&
		ctx.openImage &&
		resolveProjectImageCandidate(project.path, candidate).type === "project"
	) {
		return true;
	}
	return Boolean(
		ctx.openFileLink &&
		resolveMarkdownFileLink(toToolFileLinkInput(candidate), project.path),
	);
}

/** Opens a tool-reported file path: project images open the lightbox, other files open workspace tabs. */
export function openToolFilePath(
	ctx: FileLinkOpenContext,
	candidate: string,
): void {
	const project = ctx.project();
	if (!project) {
		ctx.toasts.show({ variant: "error", title: t("chat.fileLinkNoProject") });
		return;
	}
	const imageSource = resolveProjectImageCandidate(project.path, candidate);
	if (imageSource.type === "project" && ctx.readProjectImage && ctx.openImage) {
		void ctx
			.readProjectImage(project.id, imageSource.path)
			.then((bytes) => {
				if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
					throw new Error("image exceeds chat size limit");
				}
				ctx.openImage?.({
					url: `data:${imageSource.mimeType};base64,${bytesToBase64(bytes)}`,
					name: fileBasename(imageSource.path) || imageSource.path,
					size: bytes.length,
				});
			})
			.catch((error: unknown) => {
				ctx.toasts.show({
					variant: "error",
					title: t("chat.loadImageFailed"),
					description: error instanceof Error ? error.message : String(error),
				});
			});
		return;
	}
	const link = resolveMarkdownFileLink(
		toToolFileLinkInput(candidate),
		project.path,
	);
	if (!link) {
		ctx.toasts.show({ variant: "error", title: t("chat.fileLinkInvalid") });
		return;
	}
	openMarkdownFileLink(ctx, link);
}
