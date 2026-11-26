import type { Project } from "@shared/api/projects-types";
import { bytesToBase64 } from "@shared/base64";
import { projectImageForFilePath } from "@shared/chat/chat-markdown-images";
import {
	fileLinkPreviewKind,
	resolveLiteralFileLink,
	resolveMarkdownFileLink,
} from "@shared/chat/chat-markdown-links";
import { MAX_CHAT_IMAGE_BYTES } from "@shared/chat/chat-submission";
import { fileBasename } from "@shared/chat/chat-tool-result";
import {
	workspaceFileKey,
	type WorkspaceFile,
	type WorkspaceLineRange,
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

export interface FileLinkOpenContext {
	project: () => Pick<Project, "id" | "path"> | null;
	workspace?: WorkspaceStore;
	openFileLink?: OpenFileLinkClient;
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	openImage?: (image: ChatImagePreview) => void;
	toasts: AppToasts;
	onFileActivated?: () => void;
}

const backgroundRefreshSeq = new Map<string, number>();

/** Opens a resolved file link in the image lightbox, a workspace tab or the system app. */
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
	const { openFileLink, workspace } = ctx;
	const showOpenError = (error: unknown) => {
		ctx.toasts.show({
			variant: "error",
			title: t("chat.fileLinkOpenFailed"),
			description:
				error instanceof Error ? error.message : t("chat.fileLinkCheckPath"),
		});
	};
	const imageSource = projectImageForFilePath(project.path, decodedPath);
	if (imageSource.type === "project" && ctx.readProjectImage && ctx.openImage) {
		const { path, mimeType } = imageSource;
		void ctx
			.readProjectImage(project.id, path)
			.then((bytes) => {
				if (ctx.project()?.id !== project.id) return;
				if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
					throw new Error("image exceeds chat size limit");
				}
				ctx.openImage?.({
					url: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
					name: fileBasename(path) || path,
					size: bytes.length,
				});
			})
			.catch((error: unknown) => {
				if (ctx.project()?.id !== project.id) return;
				ctx.toasts.show({
					variant: "error",
					title: t("chat.imageUnavailable"),
					description: error instanceof Error ? error.message : String(error),
					...(openFileLink && {
						timeout: 10_000,
						action: {
							label: t("chat.fileLinkOpenInSystem"),
							onPress: () => {
								if (ctx.project()?.id !== project.id) return;
								void openFileLink(project.id, link.url, false).catch(
									showOpenError,
								);
							},
						},
					}),
				});
			});
		return;
	}
	if (!openFileLink || !workspace) {
		ctx.toasts.show({
			variant: "error",
			title: t(
				workspace ? "file.workspaceUnavailable" : "chat.fileLinkWebUnsupported",
			),
		});
		return;
	}
	const preview = fileLinkPreviewKind(decodedPath) !== null;
	const existing = preview && workspace.findFile(project.id, decodedPath);
	if (existing) {
		workspace.selectFile(project.id, existing.path, link.lineRange, true);
		ctx.onFileActivated?.();
		// 后台静默重读磁盘最新内容，避免 Agent 改完文件后预览一直停留在旧缓存；
		// 仅原地更新已打开标签的内容，不抢占用户当前视图。
		const refreshKey = `${project.id}:${workspaceFileKey(existing.path)}`;
		const seq = (backgroundRefreshSeq.get(refreshKey) ?? 0) + 1;
		backgroundRefreshSeq.set(refreshKey, seq);
		void openFileLink(project.id, link.url, true)
			.then((refreshed) => {
				if (backgroundRefreshSeq.get(refreshKey) !== seq || !refreshed) return;
				const current = workspace.findFile(project.id, refreshed.path);
				if (current && refreshed.content !== current.content) {
					workspace.refreshFile(project.id, refreshed);
				}
			})
			.catch(() => {});
		return;
	}
	void openFileLink(project.id, link.url, preview)
		.then((file) => {
			if (!file) return;
			workspace.openFile(project.id, file, link.lineRange);
			if (ctx.project()?.id === project.id) ctx.onFileActivated?.();
		})
		.catch(showOpenError);
}

function resolveReportedFilePath(candidate: string, projectPath: string) {
	return /^file:/i.test(candidate)
		? resolveMarkdownFileLink(candidate, projectPath)
		: resolveLiteralFileLink(candidate, projectPath);
}

/** Whether a reported path is a valid file target on the active connection. */
export function canOpenToolFilePath(
	ctx: FileLinkOpenContext,
	candidate: string,
): boolean {
	const project = ctx.project();
	return Boolean(project && resolveReportedFilePath(candidate, project.path));
}

/** Opens a literal file path from a mention, tool or the Git workspace. */
export function openToolFilePath(
	ctx: FileLinkOpenContext,
	candidate: string,
	lineRange?: WorkspaceLineRange,
): void {
	const project = ctx.project();
	if (!project) {
		ctx.toasts.show({ variant: "error", title: t("chat.fileLinkNoProject") });
		return;
	}
	const link = resolveReportedFilePath(candidate, project.path);
	if (!link) {
		ctx.toasts.show({ variant: "error", title: t("chat.fileLinkInvalid") });
		return;
	}
	openMarkdownFileLink(ctx, {
		...link,
		lineRange: link.lineRange ?? lineRange,
	});
}
