import { platform } from "nsh";
import type { Accessor } from "nsh";

import type { HostClient } from "@shared/api/host-client";
import type { PiModel } from "@shared/api/pi-runtime-types";
import { bytesToBase64 } from "@shared/base64";
import { registerChatFile } from "@shared/chat/chat-file-lifecycle";
import { fileMentionValue } from "@shared/chat/chat-mentions";
import {
	formatChatImageSize,
	resolveChatImageMimeType,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGE_COUNT,
	MAX_CHAT_IMAGE_TOTAL_BYTES,
	type ChatImageAttachment,
} from "@shared/chat/chat-submission";
import { piModelSupportsImages } from "@shared/pi-model-selection";

import { t } from "../shell/i18n";
import type { DesktopShell } from "../shell/desktop-shell";
import type { ComposerDraft, ComposerTarget } from "./composer-drafts";

const ATTACHMENT_NAME_LIMIT = 80;

let attachmentSequence = 0;

function attachmentName(uri: string): string {
	try {
		const path = decodeURIComponent(new URL(uri).pathname);
		return path.split("/").filter(Boolean).pop() ?? "file";
	} catch {
		return "file";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Picked, pasted, and dropped files: images go into the draft as base64
 * attachments, other files upload to the host and become `@` mentions.
 */
export class ComposerAttachments {
	constructor(
		private readonly deps: {
			client: Pick<HostClient, "uploadChatFile" | "removeChatFile">;
			shell?: Pick<DesktopShell, "readLocalFile">;
			activeModel?: Accessor<PiModel | null>;
			removedFilePaths: Set<string>;
			target: Accessor<ComposerTarget | null>;
			readDraft: (target: ComposerTarget) => ComposerDraft;
			writeDraft: (target: ComposerTarget, draft: ComposerDraft) => void;
			resolveTarget: (target: ComposerTarget) => ComposerTarget;
			setStatus: (status: string | null, sessionKey: string) => void;
		},
	) {}

	/** Inserts files into the requesting draft and returns whether any were attached. */
	async addFiles(
		files: readonly File[],
		target = this.deps.target(),
		reportFailure = true,
		collectedErrors?: string[],
	): Promise<boolean> {
		if (!target) return false;
		const { sessionKey, projectId } = target;
		const errors = collectedErrors ?? [];
		const rejectFile = (message: string) => {
			if (reportFailure && !errors.includes(message)) errors.push(message);
		};
		let attached = false;
		if (files.length > MAX_CHAT_IMAGE_COUNT) {
			rejectFile(t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }));
		}
		let batchBytes = 0;
		for (const file of files.slice(0, MAX_CHAT_IMAGE_COUNT)) {
			const mime = resolveChatImageMimeType(file);
			if (mime && !piModelSupportsImages(this.deps.activeModel?.())) {
				rejectFile(t("chat.imageUnsupported"));
				continue;
			}
			if (file.size > MAX_CHAT_IMAGE_BYTES) {
				rejectFile(
					mime
						? t("chat.imageTooLarge", { name: file.name || "image" })
						: t("chat.fileTooLarge", {
								name: file.name || "file",
								size: formatChatImageSize(MAX_CHAT_IMAGE_BYTES),
							}),
				);
				continue;
			}
			batchBytes += file.size;
			if (batchBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
				rejectFile(
					t("chat.filesTooLarge", {
						size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
					}),
				);
				break;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (mime) {
					const draft = this.deps.readDraft(this.deps.resolveTarget(target));
					const { images } = draft;
					const limit =
						images.length >= MAX_CHAT_IMAGE_COUNT
							? t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT })
							: images.reduce((total, image) => total + image.size, 0) +
										bytes.length >
								  MAX_CHAT_IMAGE_TOTAL_BYTES
								? t("chat.imagesTotalLimit", {
										size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
									})
								: null;
					if (limit) {
						rejectFile(limit);
						continue;
					}
					const image: ChatImageAttachment = {
						id: `img-${++attachmentSequence}`,
						name: file.name || "image",
						mimeType: mime,
						size: bytes.length,
						data: bytesToBase64(bytes),
					};
					this.deps.writeDraft(target, {
						...draft,
						images: [...images, image],
					});
				} else {
					const path = await this.deps.client.uploadChatFile(
						projectId,
						file.name || "file",
						bytes,
					);
					this.deps.removedFilePaths.delete(path);
					registerChatFile(path, () => {
						this.deps.removedFilePaths.add(path);
						return this.deps.client.removeChatFile(projectId, path);
					});
					const draft = this.deps.readDraft(this.deps.resolveTarget(target));
					const { value } = draft;
					const tokenText = fileMentionValue(path);
					const separator = value.length === 0 || /\s$/.test(value) ? "" : " ";
					this.deps.writeDraft(target, {
						...draft,
						value: `${value}${separator}${tokenText} `,
					});
				}
				attached = true;
			} catch (error) {
				rejectFile(
					`${t("chat.uploadFileFailed", { name: file.name || "file" })}: ${errorMessage(error)}`,
				);
			}
		}
		if (!collectedErrors) {
			if (errors.length > 0) {
				this.deps.setStatus(errors.join(" · "), sessionKey);
			} else if (attached) {
				this.deps.setStatus(null, sessionKey);
			}
		}
		return attached;
	}

	addPastedFiles(files: readonly File[], uris: readonly string[]) {
		const [file] = files;
		const [uri] = uris;
		// Windows nsh can report one image as both a file URI and a clipboard image.
		if (
			platform.os === "windows" &&
			files.length === 1 &&
			uris.length === 1 &&
			file &&
			uri &&
			((file.name === "image.bmp" && file.type === "image/bmp") ||
				(file.name === "image.png" && file.type === "image/png")) &&
			resolveChatImageMimeType({ name: attachmentName(uri), type: "" })
		) {
			void this.addUris(uris, file);
			return;
		}
		if (files.length) void this.addFiles(files);
		if (uris.length) void this.addUris(uris);
	}

	/** Pasted or dropped `file:` URIs, read natively and attached like picked files. */
	async addUris(uris: readonly string[], clipboardImage?: File) {
		const target = this.deps.target();
		if (!target) return;
		// An unsupported clipboard bitmap must not turn an image paste into a file upload.
		const fallback =
			clipboardImage && resolveChatImageMimeType(clipboardImage)
				? clipboardImage
				: undefined;
		const errors: string[] = [];
		const recordError = (message: string) => {
			if (!errors.includes(message)) errors.push(message);
		};
		if (uris.length > MAX_CHAT_IMAGE_COUNT) {
			recordError(t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }));
		}
		let batchBytes = 0;
		for (const uri of uris.slice(0, MAX_CHAT_IMAGE_COUNT)) {
			try {
				if (!this.deps.shell?.readLocalFile)
					throw new Error("no local file reads");
				const bytes = await this.deps.shell.readLocalFile(uri);
				if (bytes.length <= MAX_CHAT_IMAGE_BYTES) {
					batchBytes += bytes.length;
					if (batchBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
						recordError(
							t("chat.filesTooLarge", {
								size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
							}),
						);
						break;
					}
				}
				const name = attachmentName(uri);
				const mime = resolveChatImageMimeType({ name, type: "" });
				const attached = await this.addFiles(
					[
						new File([bytes], name.slice(0, ATTACHMENT_NAME_LIMIT), {
							type: mime ?? "",
						}),
					],
					target,
					// With a fallback, report only failure of the final attempt.
					!fallback,
					errors,
				);
				if (attached) continue;
			} catch (error) {
				if (!fallback) {
					recordError(
						`${t("chat.uploadFileFailed", { name: attachmentName(uri) })}: ${errorMessage(error)}`,
					);
				}
			}
			if (fallback) {
				await this.addFiles([fallback], target);
				return;
			}
		}
		if (errors.length > 0) {
			this.deps.setStatus(errors.join(" · "), target.sessionKey);
		}
	}
}
