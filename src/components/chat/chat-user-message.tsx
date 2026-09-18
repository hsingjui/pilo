import { memo, useState } from "react";
import { ChevronDown, Copy, Image as ImageIcon } from "lucide-react";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatMessageRender } from "@/lib/chat-performance";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

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
	const { collapseLongMessages } = usePreferences();
	const collapsible =
		collapseLongMessages && text.length > LARGE_MESSAGE_PREVIEW_CHARS;
	const [expanded, setExpanded] = useState(false);
	const visibleText = collapsible && !expanded ? plainTextPreview(text) : text;

	return (
		<div className="min-w-0">
			<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
				{visibleText}
			</p>
			{collapsible ? (
				<button
					type="button"
					className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => setExpanded((value) => !value)}
				>
					<ChevronDown
						className={cn(
							"size-3 transition-transform duration-150 ease-out",
							expanded && "rotate-180",
						)}
					/>
					{expanded ? "收起消息" : "展开完整消息"}
				</button>
			) : null}
		</div>
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
	const { pageFontSize } = usePreferences();

	return (
		<ConversationColumn className="py-2 sm:py-3">
			<div className="flex w-full justify-end">
				<div className="group flex min-w-0 max-w-[80%] flex-col items-end gap-1.5 sm:max-w-[70%]">
					<div className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
						{message.queued ? (
							<span>{message.queued === "steer" ? "待调整" : "已排队"}</span>
						) : null}
						{message.time ? <span>{message.time}</span> : null}
					</div>
					<div className="flex min-w-0 max-w-full justify-end">
						<div
							className="min-w-0 max-w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2 leading-6 text-foreground sm:px-4 sm:py-2.5"
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
										<span
											key={image.id}
											className="inline-flex max-w-52 items-center gap-1.5 rounded-md border border-foreground/10 bg-background/40 px-2 py-1 text-xs"
										>
											<ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
											<span className="truncate">{image.name}</span>
										</span>
									))}
								</div>
							) : null}
							{message.text ? <UserMessageBody text={message.text} /> : null}
						</div>
					</div>
					<div className="flex gap-0.5">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7 rounded-md text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
									aria-label="复制"
									onClick={() =>
										void navigator.clipboard.writeText(message.text)
									}
								>
									<Copy className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>复制</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</div>
		</ConversationColumn>
	);
});
