import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Sparkles } from "lucide-react";

import { ChatImageThumbnail } from "@/components/chat/chat-image-viewer";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { ChatCopyButton } from "@/components/chat/chat-copy-button";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatMessageRender } from "@/lib/chat-performance";
import { usePreferences } from "@/lib/preferences-provider";
import type { SkillInvocation } from "@/lib/skill-invocation";
import { parseSkillInvocation } from "@/lib/skill-invocation";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui";

const LARGE_MESSAGE_PREVIEW_CHARS = 8_000;

function plainTextPreview(text: string) {
	let preview = text.slice(0, LARGE_MESSAGE_PREVIEW_CHARS);
	const lastLineBreak = preview.lastIndexOf("\n");
	if (lastLineBreak > LARGE_MESSAGE_PREVIEW_CHARS * 0.75) {
		preview = preview.slice(0, lastLineBreak);
	}
	const fenceCount = preview.match(/```/g)?.length ?? 0;
	if (fenceCount % 2 === 1) preview += "\n```";
	return `${preview}\n\n…`;
}

function UserMessageBody({ text }: { text: string }) {
	const { t } = useTranslation();
	const { collapseLongMessages } = usePreferences();
	const [expanded, setExpanded] = useState(false);
	const invocation = parseSkillInvocation(text);
	if (invocation) {
		return <SkillInvocationBody invocation={invocation} />;
	}
	const collapsible =
		collapseLongMessages && text.length > LARGE_MESSAGE_PREVIEW_CHARS;
	const visibleText = collapsible && !expanded ? plainTextPreview(text) : text;

	return (
		<div className="min-w-0">
			<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
				{visibleText}
			</p>
			{collapsible ? (
				<button
					type="button"
					className="mt-2 inline-flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => setExpanded((value) => !value)}
				>
					<ChevronDown
						className={cn(
							"size-3 transition-transform duration-150 ease-out",
							expanded && "rotate-180",
						)}
					/>
					{expanded ? t("chat.collapseMessage") : t("chat.expandMessage")}
				</button>
			) : null}
		</div>
	);
}

/** Skill 调用只显示紧凑占位，不回显 Pi 展开的 Skill 正文。 */
function SkillInvocationBody({ invocation }: { invocation: SkillInvocation }) {
	return (
		<Hint label={invocation.location ?? undefined}>
			<span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-foreground/10 bg-background/40 px-2 py-1 text-xs">
				<Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 truncate font-mono">{invocation.name}</span>
			</span>
		</Hint>
	);
}

export const UserMessage = memo(function UserMessage({
	message,
	recordRender = true,
}: {
	message: Extract<ChatMessage, { role: "user" }>;
	recordRender?: boolean;
}) {
	if (recordRender) recordChatMessageRender("user");
	const { t } = useTranslation();
	const { pageFontSize } = usePreferences();

	return (
		<ConversationColumn className="py-2 @min-[40rem]:py-3">
			<div className="flex w-full justify-end">
				<div className="group flex min-w-0 max-w-[80%] flex-col items-end gap-1.5 @min-[40rem]:max-w-[70%]">
					{message.queued ? (
						<div className="text-2xs tabular-nums text-muted-foreground">
							{message.queued === "steer" ? t("chat.adjust") : t("chat.queued")}
						</div>
					) : null}
					<div className="flex min-w-0 max-w-full justify-end">
						<div
							className="min-w-0 max-w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2 leading-6 text-foreground @min-[40rem]:px-4 @min-[40rem]:py-2.5"
							style={{ fontSize: `${pageFontSize}px` }}
						>
							{message.images && message.images.length > 0 ? (
								<div
									className={cn(
										"flex flex-wrap gap-1.5",
										message.text && "mb-2",
									)}
								>
									{message.images.map((image) => (
										<ChatImageThumbnail key={image.id} image={image} />
									))}
								</div>
							) : null}
							{message.text ? <UserMessageBody text={message.text} /> : null}
						</div>
					</div>
					<div className="flex items-center gap-1.5">
						<ChatCopyButton text={message.text} />
						{message.time ? (
							<span className="text-2xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
								{message.time}
							</span>
						) : null}
					</div>
				</div>
			</div>
		</ConversationColumn>
	);
});
