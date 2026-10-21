import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { i18n } from "@/i18n";
import { userErrorMessage } from "@/lib/app-error";
import { cacheLocalChatImages } from "@/lib/chat/chat-image-media";
import { discardChatFiles } from "@/lib/chat/chat-file-lifecycle";
import { randomId } from "@/lib/utils";
import {
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGE_COUNT,
	MAX_CHAT_IMAGE_TOTAL_BYTES,
	formatChatImageSize,
	resolveChatImageMimeType,
	type ChatImageAttachment,
} from "@/lib/chat/chat-submission";

const EMPTY_IMAGES: readonly ChatImageAttachment[] = [];

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
				id: randomId(),
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

export function useChatComposerAttachments({
	images,
	onImagesChange,
	onUploadFile,
	onAttachmentsAdded,
	scopeKey,
	disabled,
	rootRef,
}: {
	images?: readonly ChatImageAttachment[];
	onImagesChange?: (images: ChatImageAttachment[]) => void;
	onUploadFile?: (file: File) => Promise<string>;
	onAttachmentsAdded: (paths: string[], orderedKeys: string[]) => void;
	scopeKey?: string | null;
	disabled: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
}) {
	const { t } = useTranslation();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [localImages, setLocalImages] = useState<{
		scopeKey: typeof scopeKey;
		images: ChatImageAttachment[];
	}>({ scopeKey, images: [] });
	const attachments =
		images ??
		(localImages.scopeKey === scopeKey ? localImages.images : EMPTY_IMAGES);
	// A new identity also invalidates A → B → A switches during a read/upload.
	const scope = useMemo(() => ({ scopeKey, disabled }), [scopeKey, disabled]);
	const [pendingScope, setPendingScope] = useState<object | null>(null);
	const [dragScope, setDragScope] = useState<object | null>(null);
	const operationRef = useRef<object | null>(null);
	const latestRef = useRef<{
		scope: object;
		onAttachmentsAdded: typeof onAttachmentsAdded;
		addFiles: (files: readonly File[]) => Promise<void>;
	} | null>(null);
	const processing = pendingScope === scope;
	const dragging = dragScope === scope && !disabled && !processing;

	const updateImages = useCallback(
		(next: ChatImageAttachment[]) => {
			cacheLocalChatImages(next);
			if (onImagesChange) onImagesChange(next);
			else setLocalImages({ scopeKey, images: next });
		},
		[onImagesChange, scopeKey],
	);

	const addFiles = async (files: readonly File[]) => {
		if (files.length === 0 || disabled || operationRef.current === scope)
			return;
		operationRef.current = scope;
		setPendingScope(scope);
		const isCurrent = () => latestRef.current?.scope === scope;
		const accepted: Array<{ file: File; mimeType: string | null }> = [];
		let imageCount = attachments.length;
		let imageBytes = attachments.reduce(
			(total, image) => total + image.size,
			0,
		);
		let batchBytes = 0;
		if (files.length > MAX_CHAT_IMAGE_COUNT)
			toast.info(t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }));
		try {
			for (const file of files.slice(0, MAX_CHAT_IMAGE_COUNT)) {
				if (!isCurrent()) break;
				if (file.size > MAX_CHAT_IMAGE_BYTES) {
					toast.error(
						t("chat.fileTooLarge", {
							name: file.name,
							size: formatChatImageSize(MAX_CHAT_IMAGE_BYTES),
						}),
					);
					continue;
				}
				if (batchBytes + file.size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
					toast.error(
						t("chat.filesTooLarge", {
							size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
						}),
					);
					break;
				}
				batchBytes += file.size;
				const mimeType = resolveChatImageMimeType(file);
				if (mimeType) {
					if (imageCount >= MAX_CHAT_IMAGE_COUNT) {
						toast.error(t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT }));
						continue;
					}
					if (imageBytes + file.size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
						toast.error(t("chat.imagesTooLarge"), {
							description: t("chat.imagesTotalLimit", {
								size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
							}),
						});
						continue;
					}
					imageCount += 1;
					imageBytes += file.size;
				} else if (!onUploadFile) {
					toast.error(t("chat.fileProjectRequired"));
					continue;
				}
				accepted.push({ file, mimeType });
			}
			// The batch is capped at eight files and 20 MB before any reads begin.
			const added = await Promise.all(
				accepted.map(async ({ file, mimeType }) => {
					try {
						if (!isCurrent()) return null;
						if (mimeType) return { image: await readImage(file, mimeType) };
						if (onUploadFile) return { path: await onUploadFile(file) };
					} catch (error) {
						if (isCurrent())
							toast.error(t("chat.uploadFileFailed", { name: file.name }), {
								description: userErrorMessage(error),
							});
					}
					return null;
				}),
			);
			if (!isCurrent()) {
				discardChatFiles(
					added.flatMap((result) => (result?.path ? [result.path] : [])),
				);
				return;
			}
			const addedImages = added.flatMap((result) =>
				result?.image ? [result.image] : [],
			);
			const paths = added.flatMap((result) =>
				result?.path ? [result.path] : [],
			);
			if (addedImages.length) updateImages([...attachments, ...addedImages]);
			// Promise.all retains accepted-file order, unlike the grouped payloads above.
			const orderedKeys = added.flatMap((result) =>
				result?.image
					? [`image:${result.image.id}`]
					: result?.path
						? [`file:${result.path}`]
						: [],
			);
			if (orderedKeys.length)
				latestRef.current?.onAttachmentsAdded(paths, orderedKeys);
		} finally {
			if (operationRef.current === scope) operationRef.current = null;
			if (isCurrent()) setPendingScope(null);
		}
	};

	useLayoutEffect(() => {
		latestRef.current = { scope, onAttachmentsAdded, addFiles };
		return () => {
			latestRef.current = null;
		};
	});

	const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		void addFiles(files);
		event.target.value = "";
	};

	const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
		const files = Array.from(event.clipboardData.items)
			.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
			.flatMap((item) => {
				const file = item.getAsFile();
				return file ? [file] : [];
			});
		if (files.length > 0) {
			event.preventDefault();
			void addFiles(files);
		}
	};

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const panel = root.closest("[data-chat-panel]") ?? root;
		const insidePanel = (target: EventTarget | null) =>
			target instanceof Node && panel.contains(target);
		const visible = () =>
			root.getClientRects().length > 0 && !root.closest('[aria-hidden="true"]');
		const available = () =>
			visible() &&
			!disabled &&
			operationRef.current !== scope &&
			!root.querySelector<HTMLTextAreaElement>("[data-chat-composer-input]")
				?.disabled &&
			!document.querySelector('[role="dialog"], [role="alertdialog"]');
		const hasFiles = (event: DragEvent) =>
			event.dataTransfer?.types.includes("Files");
		const over = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			if (!visible()) return;
			const allowed = insidePanel(event.target) && available();
			if (event.dataTransfer)
				event.dataTransfer.dropEffect = allowed ? "copy" : "none";
			setDragScope(allowed ? scope : null);
		};
		const leave = (event: DragEvent) => {
			if (!insidePanel(event.relatedTarget)) setDragScope(null);
		};
		const drop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			setDragScope(null);
			if (!insidePanel(event.target) || !available() || !event.dataTransfer)
				return;
			const items = Array.from(event.dataTransfer.items);
			if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
				toast.error(t("chat.foldersUnsupported"));
				return;
			}
			void latestRef.current?.addFiles(Array.from(event.dataTransfer.files));
			root
				.querySelector<HTMLElement>("[data-chat-composer-input]")
				?.focus({ preventScroll: true });
		};
		window.addEventListener("dragover", over);
		window.addEventListener("dragleave", leave);
		window.addEventListener("drop", drop);
		return () => {
			window.removeEventListener("dragover", over);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("drop", drop);
		};
	}, [rootRef, disabled, scope, t]);

	return {
		processing,
		dragging,
		fileInputRef,
		attachments,
		updateImages,
		handleFiles,
		handlePaste,
	};
}
