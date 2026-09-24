import { useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { i18n } from "@/i18n";
import { userErrorMessage } from "@/lib/app-error";
import { cacheLocalChatImages } from "@/lib/chat-image-media";
import {
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGE_COUNT,
	MAX_CHAT_IMAGE_TOTAL_BYTES,
	formatChatImageSize,
	resolveChatImageMimeType,
	type ChatImageAttachment,
} from "@/lib/chat-submission";

function readImage(file: File, mimeType: string) {
	return new Promise<ChatImageAttachment>((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("error", () => {
			reject(reader.error ?? new Error(i18n.t("chat.readImageFailed")));
		});
		reader.addEventListener("load", () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error(i18n.t("chat.readImageFailed")));
				return;
			}
			const separator = result.indexOf(",");
			if (separator < 0) {
				reject(new Error(i18n.t("chat.invalidImage")));
				return;
			}
			resolve({
				id: crypto.randomUUID(),
				name:
					file.name ||
					`${i18n.t("chat.imageClipboard")}.${mimeType.split("/")[1] ?? "png"}`,
				mimeType,
				size: file.size,
				data: result.slice(separator + 1),
			});
		});
		reader.readAsDataURL(file);
	});
}

/**
 * Composer attachment state (controlled or local) plus file input / paste
 * validation for image attachments.
 */
export function useChatComposerImages({
	images,
	onImagesChange,
}: {
	images?: readonly ChatImageAttachment[];
	onImagesChange?: (images: ChatImageAttachment[]) => void;
}) {
	const { t } = useTranslation();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [localImages, setLocalImages] = useState<ChatImageAttachment[]>([]);
	const attachments = images ?? localImages;

	const updateImages = (next: ChatImageAttachment[]) => {
		cacheLocalChatImages(next);
		if (onImagesChange) onImagesChange(next);
		else setLocalImages(next);
	};

	const addImageFiles = async (files: readonly File[]) => {
		if (files.length === 0) return;

		const availableSlots = Math.max(
			0,
			MAX_CHAT_IMAGE_COUNT - attachments.length,
		);
		if (availableSlots === 0) {
			toast.error(t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT }));
			return;
		}
		const accepted: Array<{ file: File; mimeType: string }> = [];
		let totalBytes = attachments.reduce(
			(total, image) => total + image.size,
			0,
		);
		for (const file of files) {
			if (accepted.length >= availableSlots) break;
			const mimeType = resolveChatImageMimeType(file);
			if (!mimeType) {
				toast.error(
					t("chat.unsupportedImage", {
						name: file.name || t("chat.imageClipboard"),
					}),
				);
				continue;
			}
			if (file.size > MAX_CHAT_IMAGE_BYTES) {
				toast.error(
					t("chat.imageTooLarge", {
						name: file.name || t("chat.imageClipboard"),
					}),
					{
						description: t("chat.imageSizeLimit", {
							size: formatChatImageSize(MAX_CHAT_IMAGE_BYTES),
						}),
					},
				);
				continue;
			}
			if (totalBytes + file.size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
				toast.error(t("chat.imagesTooLarge"), {
					description: t("chat.imagesTotalLimit", {
						size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
					}),
				});
				break;
			}
			accepted.push({ file, mimeType });
			totalBytes += file.size;
		}
		if (files.length > availableSlots) {
			toast.info(t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT }));
		}
		if (accepted.length === 0) return;
		try {
			const added = await Promise.all(
				accepted.map(({ file, mimeType }) => readImage(file, mimeType)),
			);
			updateImages([...attachments, ...added]);
		} catch (error) {
			toast.error(t("chat.readImageFailed"), {
				description: userErrorMessage(error),
			});
		}
	};

	const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		void addImageFiles(files);
		event.target.value = "";
	};

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData.items)
			.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
			.flatMap((item) => {
				const file = item.getAsFile();
				return file ? [file] : [];
			});
		if (files.length > 0) {
			event.preventDefault();
			void addImageFiles(files);
		}
	};

	return {
		fileInputRef,
		attachments,
		updateImages,
		handleFiles,
		handlePaste,
	};
}
