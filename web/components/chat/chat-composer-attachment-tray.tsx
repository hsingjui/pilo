import { useTranslation } from "react-i18next";

import { ChatImageThumbnail } from "@/components/chat/chat-image-viewer";
import { ComposerAttachment } from "@/components/chat/composer-attachment";
import { FileMentionBadge } from "@/components/chat/path-mention-badge";
import { SessionMentionBadge } from "@/components/chat/session-mention-badge";
import type { ComposerAttachmentItem } from "@/components/chat/use-chat-composer-attachment-tray";
import { fileMentionName } from "@shared/chat/chat-mentions";

export function ChatComposerAttachmentTray({
	items,
	disabled,
	processing,
	onRemove,
}: {
	items: readonly ComposerAttachmentItem[];
	disabled: boolean;
	processing: boolean;
	onRemove: (key: string) => void;
}) {
	const { t } = useTranslation();
	if (!items.length) return null;
	return (
		<div
			data-chat-composer-attachments=""
			data-chat-composer-references=""
			className="mb-1 flex max-h-[min(8rem,25dvh,var(--pilo-composer-attachments-max-height,8rem))] min-w-0 flex-wrap items-center gap-1.5 overflow-y-auto overscroll-contain p-1"
		>
			{items.map((item) => {
				if (item.kind === "image") {
					const { key, attachment } = item;
					return (
						<ComposerAttachment
							key={key}
							kind="image"
							disabled={disabled || processing}
							removeLabel={t("chat.removeAttachment", {
								name: attachment.name,
							})}
							onRemove={() => onRemove(key)}
						>
							<ChatImageThumbnail
								compact
								image={{
									id: attachment.id,
									name: attachment.name,
									mimeType: attachment.mimeType,
									size: attachment.size,
									source: "local",
								}}
							/>
						</ComposerAttachment>
					);
				}
				const { key, mention } = item;
				return (
					<ComposerAttachment
						key={key}
						kind="reference"
						disabled={disabled}
						removeLabel={
							mention.kind === "session"
								? t("chat.removeSessionMention", {
										title: mention.session.title,
									})
								: t("chat.removeAttachment", {
										name: fileMentionName(mention.path),
									})
						}
						onRemove={() => onRemove(key)}
					>
						{mention.kind === "session" ? (
							<SessionMentionBadge mention={mention.session} compact />
						) : (
							<FileMentionBadge path={mention.path} compact />
						)}
					</ComposerAttachment>
				);
			})}
		</div>
	);
}
