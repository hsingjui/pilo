import { memo, useState, type ReactNode } from "react";
import { ChevronDown, Copy } from "lucide-react";

import {
	AssistantActivityView,
	type AssistantActivity,
} from "@/components/chat/chat-activity";
import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import {
	getAssistantActivities,
	getAssistantStreamingLabel,
	type AssistantContentItem,
} from "@/lib/chat-activity-state";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatMessageRender } from "@/lib/chat-performance";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import {
	Button,
	EmptyState,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

export function ConversationColumn({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("mx-auto w-full max-w-[46rem] px-3 sm:px-4", className)}>
			{children}
		</div>
	);
}

function MessageAction({
	label,
	children,
	onClick,
}: {
	label: string;
	children: ReactNode;
	onClick?: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7 rounded-md text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
					aria-label={label}
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

const LARGE_MESSAGE_PREVIEW_CHARS = 8_000;

function markdownPreview(text: string) {
	let preview = text.slice(0, LARGE_MESSAGE_PREVIEW_CHARS);
	const lastLineBreak = preview.lastIndexOf("\n");
	if (lastLineBreak > LARGE_MESSAGE_PREVIEW_CHARS * 0.75) {
		preview = preview.slice(0, lastLineBreak);
	}
	const fenceCount = preview.match(/```/g)?.length ?? 0;
	if (fenceCount % 2 === 1) preview += "\n```";
	return `${preview}\n\n…`;
}

function CollapsibleMessageBody({
	text,
	markdown = false,
	streaming = false,
}: {
	text: string;
	markdown?: boolean;
	streaming?: boolean;
}) {
	const collapsible = !streaming && text.length > LARGE_MESSAGE_PREVIEW_CHARS;
	const [expanded, setExpanded] = useState(false);
	const visibleText = collapsible && !expanded ? markdownPreview(text) : text;

	return (
		<div className="min-w-0 [content-visibility:auto] [contain-intrinsic-size:auto_96px]">
			{markdown ? (
				<ChatMarkdown text={visibleText} isStreaming={streaming} />
			) : (
				<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
					{visibleText}
				</p>
			)}
			{collapsible ? (
				<button
					type="button"
					className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => setExpanded((value) => !value)}
				>
					<ChevronDown
						className={cn(
							"size-3 transition-transform",
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
}: {
	message: Extract<ChatMessage, { role: "user" }>;
}) {
	recordChatMessageRender("user");
	const { conversationFontSize } = usePreferences();

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
							className="min-w-0 max-w-full rounded-[1.15rem] border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2 leading-6 text-foreground sm:rounded-2xl sm:px-4 sm:py-2.5"
							style={{ fontSize: `${conversationFontSize}px` }}
						>
							<CollapsibleMessageBody text={message.text} />
						</div>
					</div>
					<div className="flex gap-0.5">
						<MessageAction
							label="复制"
							onClick={() => void navigator.clipboard.writeText(message.text)}
						>
							<Copy className="size-3.5" />
						</MessageAction>
					</div>
				</div>
			</div>
		</ConversationColumn>
	);
});

function getAssistantMessageContent(
	message: Extract<ChatMessage, { role: "assistant" }>,
): AssistantContentItem[] {
	if (message.content) return message.content;

	const content: AssistantContentItem[] = [];
	if (message.activity) content.push(...message.activity);
	if (message.text) {
		content.push({
			id: `${message.id}-text`,
			type: "text",
			text: message.text,
		});
	}
	return content;
}

export const AssistantMessage = memo(function AssistantMessage({
	message,
	replyRunwayPx,
	onOpenFile,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	replyRunwayPx?: number;
	onOpenFile?: (path: string) => void;
}) {
	recordChatMessageRender("assistant");
	const { conversationFontSize, showWorkDuration } = usePreferences();
	const content = getAssistantMessageContent(message);
	const activity = getAssistantActivities(content);
	const streamingLabel = getAssistantStreamingLabel({
		text: message.text,
		activity,
		streaming: message.streaming,
	});
	const hasWorkActivity = activity.length > 0;
	const footerDuration =
		showWorkDuration && !hasWorkActivity && message.workDurationMs !== undefined
			? formatWorkDuration(message.workDurationMs)
			: "";
	const contentNodes: ReactNode[] = [];
	let firstActivityGroup = true;

	for (let index = 0; index < content.length; index += 1) {
		const item = content[index];
		if (item.type === "text") {
			if (item.text) {
				contentNodes.push(
					<CollapsibleMessageBody
						key={item.id}
						text={item.text}
						markdown
						streaming={
							message.streaming === true && index === content.length - 1
						}
					/>,
				);
			}
			continue;
		}

		const group: AssistantActivity[] = [];
		const groupStart = index;
		while (index < content.length && content[index].type !== "text") {
			group.push(content[index] as AssistantActivity);
			index += 1;
		}
		index -= 1;
		const groupKey = group[0]?.id ?? `activity-${groupStart}`;
		contentNodes.push(
			<AssistantActivityView
				key={`${message.id}-${groupKey}-${message.streaming ? "running" : "complete"}`}
				activity={group}
				streaming={message.streaming === true}
				durationMs={firstActivityGroup ? message.workDurationMs : undefined}
				onOpenPath={onOpenFile}
			/>,
		);
		firstActivityGroup = false;
	}

	return (
		<ConversationColumn className="group py-2 sm:py-3">
			<div
				className="w-full text-foreground"
				style={
					replyRunwayPx === undefined
						? { fontSize: `${conversationFontSize}px` }
						: {
								fontSize: `${conversationFontSize}px`,
								minHeight: `${replyRunwayPx}px`,
							}
				}
			>
				<div className="relative">
					{contentNodes}
					{message.errorMessage ? (
						<div
							role="alert"
							className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
						>
							{message.errorMessage}
						</div>
					) : null}
					{streamingLabel ||
					message.errorMessage ||
					message.stopReason === "aborted" ? (
						<div className="mt-1 flex min-h-6 items-center gap-1 text-[11px] text-muted-foreground">
							{streamingLabel ? (
								<ChatAgentActivityIndicator label={streamingLabel} />
							) : message.errorMessage ? (
								<span className="text-destructive">Pi 响应失败</span>
							) : (
								<span>已停止</span>
							)}
						</div>
					) : !message.streaming &&
					  (message.text || message.time || footerDuration) ? (
						<div className="mt-0.5 flex min-h-7 flex-wrap items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
							{message.text ? (
								<MessageAction
									label="复制"
									onClick={() =>
										void navigator.clipboard.writeText(message.text)
									}
								>
									<Copy className="size-3.5" />
								</MessageAction>
							) : null}
							{message.time ? (
								<span className="tabular-nums">{message.time}</span>
							) : null}
							{message.time && footerDuration ? (
								<span aria-hidden="true">·</span>
							) : null}
							{footerDuration ? (
								<span className="font-mono tabular-nums">{footerDuration}</span>
							) : null}
						</div>
					) : null}
				</div>
			</div>
		</ConversationColumn>
	);
});

export function EmptyConversation() {
	return (
		<ConversationColumn className="flex flex-1 items-center justify-center">
			<EmptyState
				variant="hero"
				title="今天想做点什么？"
				icon={
					<svg viewBox="0 0 800 800" className="h-20 w-20" aria-hidden="true">
						<path
							className="fill-current"
							fillRule="evenodd"
							d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						/>
						<path
							className="fill-current"
							d="M517.36 400H634.72V634.72H517.36Z"
						/>
					</svg>
				}
			/>
		</ConversationColumn>
	);
}
