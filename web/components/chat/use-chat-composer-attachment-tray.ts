import { useCallback, useMemo, useState } from "react";

import { useChatComposerAttachments } from "@/components/chat/use-chat-composer-attachments";
import {
	writeChatMentionDraft,
	type ChatMention,
} from "@shared/chat/chat-mentions";
import type { ChatImageAttachment } from "@shared/chat/chat-submission";

export type ComposerAttachmentItem = { key: string } & (
	| { kind: "image"; attachment: ChatImageAttachment }
	| { kind: "reference"; mention: ChatMention; index: number }
);

type AttachmentTrayOptions = Omit<
	Parameters<typeof useChatComposerAttachments>[0],
	"onAttachmentsAdded"
> & {
	mentionDraft: { references: readonly ChatMention[]; text: string };
	changeDraft: (value: string) => void;
	onNextPromptDismiss?: () => void;
};

export function useChatComposerAttachmentTray({
	mentionDraft,
	changeDraft,
	onNextPromptDismiss,
	...fileOptions
}: AttachmentTrayOptions) {
	const { scopeKey } = fileOptions;
	const [attachmentOrder, setAttachmentOrder] = useState<{
		scope: typeof scopeKey;
		keys: string[];
	}>({ scope: scopeKey, keys: [] });
	const { attachments, updateImages, processing, ...fileHandlers } =
		useChatComposerAttachments({
			...fileOptions,
			onAttachmentsAdded: (paths, orderedKeys) => {
				setAttachmentOrder((current) => ({
					scope: scopeKey,
					keys: [
						...new Set([
							...(current.scope === scopeKey ? current.keys : []),
							...orderedKeys,
						]),
					],
				}));
				if (paths.length === 0) return;
				onNextPromptDismiss?.();
				changeDraft(
					writeChatMentionDraft(
						[
							...mentionDraft.references,
							...paths.map((path) => ({ kind: "file" as const, path })),
						],
						mentionDraft.text,
					),
				);
			},
		});
	const attachmentItems = useMemo(() => {
		const items = new Map<string, ComposerAttachmentItem>();
		for (const attachment of attachments) {
			const key = `image:${attachment.id}`;
			items.set(key, { key, kind: "image", attachment });
		}
		for (const [index, mention] of mentionDraft.references.entries()) {
			const key = `${mention.kind}:${mention.path}`;
			items.set(key, { key, kind: "reference", mention, index });
		}
		return items;
	}, [attachments, mentionDraft.references]);
	const orderedAttachmentKeys = useMemo(() => {
		const previousKeys =
			attachmentOrder.scope === scopeKey ? attachmentOrder.keys : [];
		const previousKeySet = new Set(previousKeys);
		return [
			...previousKeys.filter((key) => attachmentItems.has(key)),
			...[...attachmentItems.keys()].filter((key) => !previousKeySet.has(key)),
		];
	}, [attachmentOrder, scopeKey, attachmentItems]);
	// Keep one insertion order across images and references, before layout effects run.
	if (
		attachmentOrder.scope !== scopeKey ||
		attachmentOrder.keys.length !== orderedAttachmentKeys.length ||
		attachmentOrder.keys.some(
			(key, index) => key !== orderedAttachmentKeys[index],
		)
	) {
		setAttachmentOrder({ scope: scopeKey, keys: orderedAttachmentKeys });
	}

	const orderedItems = useMemo(
		() =>
			orderedAttachmentKeys.flatMap((key) => {
				const item = attachmentItems.get(key);
				return item ? [item] : [];
			}),
		[attachmentItems, orderedAttachmentKeys],
	);
	const removeAttachment = useCallback(
		(key: string, source: "button" | "backspace" = "button") => {
			const item = attachmentItems.get(key);
			if (!item || (item.kind === "image" && processing)) return;
			if (source === "backspace" || item.kind === "reference")
				onNextPromptDismiss?.();
			if (item.kind === "image") {
				updateImages(
					attachments.filter((image) => image.id !== item.attachment.id),
				);
			} else {
				changeDraft(
					writeChatMentionDraft(
						mentionDraft.references.filter((_, index) => index !== item.index),
						mentionDraft.text,
					),
				);
			}
			return item.kind;
		},
		[
			attachmentItems,
			processing,
			attachments,
			updateImages,
			mentionDraft,
			changeDraft,
			onNextPromptDismiss,
		],
	);
	const removeLastAttachment = useCallback(() => {
		const key = orderedAttachmentKeys[orderedAttachmentKeys.length - 1];
		return (
			key !== undefined && removeAttachment(key, "backspace") !== undefined
		);
	}, [orderedAttachmentKeys, removeAttachment]);

	return {
		...fileHandlers,
		attachments,
		processing,
		orderedItems,
		removeAttachment,
		removeLastAttachment,
	};
}
