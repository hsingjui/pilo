import { memo, useState, type ReactNode } from "react";
import {
	ChevronDown,
	ChevronRight,
	Copy,
	GitFork,
	LoaderCircle,
} from "lucide-react";

import {
	AssistantActivityView,
	type AssistantActivity,
} from "@/components/chat/chat-activity";
import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { useChatExpansionState } from "@/components/chat/chat-expansion-state";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import {
	getAssistantActivities,
	getAssistantStreamingLabel,
	splitAssistantContentForDisplay,
	type AssistantContentItem,
} from "@/lib/chat-activity-state";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatMessageRender } from "@/lib/chat-performance";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

function MessageAction({
	label,
	children,
	onClick,
	disabled = false,
}: {
	label: string;
	children: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
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
					disabled={disabled}
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
	const { collapseLongMessages } = usePreferences();
	const collapsible =
		collapseLongMessages &&
		!streaming &&
		text.length > LARGE_MESSAGE_PREVIEW_CHARS;
	const [expanded, setExpanded] = useState(false);
	const visibleText = collapsible && !expanded ? markdownPreview(text) : text;

	return (
		<div className="min-w-0">
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

function renderAssistantContentNodes({
	messageId,
	content,
	streaming,
	preserveActivityExpanded = false,
	durationMs,
	onOpenFile,
}: {
	messageId: string;
	content: AssistantContentItem[];
	streaming: boolean;
	preserveActivityExpanded?: boolean;
	durationMs?: number;
	onOpenFile?: (path: string) => void;
}) {
	const nodes: ReactNode[] = [];
	let firstActivityGroup = true;

	for (let index = 0; index < content.length; index += 1) {
		const item = content[index];
		if (item.type === "text") {
			if (item.text) {
				nodes.push(
					<CollapsibleMessageBody
						key={item.id}
						text={item.text}
						markdown
						streaming={streaming && index === content.length - 1}
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
		const activityStateKey =
			streaming || preserveActivityExpanded ? "expanded" : "complete";
		nodes.push(
			<div key={`${messageId}-${groupKey}-${activityStateKey}`}>
				<AssistantActivityView
					activity={group}
					streaming={streaming}
					preserveExpanded={preserveActivityExpanded}
					expansionKey={`${messageId}:${groupKey}:${activityStateKey}`}
					durationMs={firstActivityGroup ? durationMs : undefined}
					onOpenPath={onOpenFile}
				/>
			</div>,
		);
		firstActivityGroup = false;
	}

	return nodes;
}

function AssistantWorkedRegion({
	messageId,
	content,
	durationMs,
	onOpenFile,
}: {
	messageId: string;
	content: AssistantContentItem[];
	durationMs?: number;
	onOpenFile?: (path: string) => void;
}) {
	const { collapseCompletedActivity, showWorkDuration } = usePreferences();
	const [open, setOpen] = useChatExpansionState(
		`worked:${messageId}`,
		!collapseCompletedActivity,
	);
	const durationLabel =
		showWorkDuration && durationMs !== undefined
			? formatWorkDuration(durationMs)
			: "";

	return (
		<div className="mb-1 mt-0.5 w-full text-muted-foreground">
			<button
				type="button"
				className="group/work flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-left text-[12.5px] font-medium leading-snug text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 transition-transform duration-200",
						open && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">
					{durationLabel ? `工作了 ${durationLabel}` : "工作过程"}
				</span>
			</button>
			{open ? (
				<div className="pt-0.5">
					{renderAssistantContentNodes({
						messageId,
						content,
						streaming: false,
						onOpenFile,
					})}
				</div>
			) : null}
		</div>
	);
}

export const AssistantMessage = memo(function AssistantMessage({
	message,
	replyRunwayPx,
	onOpenFile,
	onFork,
	forking = false,
	forkDisabled = false,
	suppressInterruptedError = false,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	replyRunwayPx?: number;
	onOpenFile?: (path: string) => void;
	onFork?: (messageId: string) => void;
	forking?: boolean;
	forkDisabled?: boolean;
	suppressInterruptedError?: boolean;
}) {
	recordChatMessageRender("assistant");
	const { pageFontSize, showWorkDuration } = usePreferences();
	const content = getAssistantMessageContent(message);
	const activity = getAssistantActivities(content);
	const displaySections = splitAssistantContentForDisplay(
		content,
		message.streaming !== true && message.completion !== "continued",
	);
	const streamingLabel = getAssistantStreamingLabel({
		text: message.text,
		activity,
		streaming: message.streaming,
	});
	const hasWorkActivity = activity.length > 0;
	const workDurationOwnedByContent =
		hasWorkActivity || displaySections.hasCollapsedWork;
	const visibleAssistantText = (
		displaySections.hasCollapsedWork ? displaySections.final : content
	)
		.filter(
			(item): item is Extract<AssistantContentItem, { type: "text" }> =>
				item.type === "text",
		)
		.map((item) => item.text)
		.join("");
	const footerDuration =
		showWorkDuration &&
		!workDurationOwnedByContent &&
		message.workDurationMs !== undefined
			? formatWorkDuration(message.workDurationMs)
			: "";
	const visibleErrorMessage =
		suppressInterruptedError && message.completion === "interrupted"
			? undefined
			: message.errorMessage;
	const canFork =
		Boolean(onFork) &&
		message.streaming !== true &&
		message.completion !== "continued" &&
		!message.errorMessage &&
		message.stopReason !== "aborted";
	const contentNodes = displaySections.hasCollapsedWork
		? [
				<AssistantWorkedRegion
					key={`${message.id}-worked`}
					messageId={message.id}
					content={displaySections.work}
					durationMs={message.workDurationMs}
					onOpenFile={onOpenFile}
				/>,
				...renderAssistantContentNodes({
					messageId: message.id,
					content: displaySections.final,
					streaming: message.streaming === true,
					preserveActivityExpanded: message.streaming === true,
					onOpenFile,
				}),
			]
		: renderAssistantContentNodes({
				messageId: message.id,
				content,
				streaming: message.streaming === true,
				preserveActivityExpanded: message.completion === "continued",
				durationMs: message.workDurationMs,
				onOpenFile,
			});

	return (
		<ConversationColumn className="group py-2 sm:py-3">
			<div
				className="w-full text-foreground"
				style={
					replyRunwayPx === undefined
						? { fontSize: `${pageFontSize}px` }
						: {
								fontSize: `${pageFontSize}px`,
								minHeight: `${replyRunwayPx}px`,
							}
				}
			>
				<div className="relative">
					{contentNodes}
					{visibleErrorMessage ? (
						<div
							role="alert"
							className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
						>
							{visibleErrorMessage}
						</div>
					) : null}
					{streamingLabel ||
					visibleErrorMessage ||
					message.stopReason === "aborted" ? (
						<div className="mt-1 flex min-h-6 items-center gap-1 text-[11px] text-muted-foreground">
							{streamingLabel ? (
								<ChatAgentActivityIndicator label={streamingLabel} />
							) : visibleErrorMessage ? (
								<span className="text-destructive">Pi 响应失败</span>
							) : (
								<span>已停止</span>
							)}
						</div>
					) : !message.streaming &&
					  (visibleAssistantText ||
							message.time ||
							footerDuration ||
							canFork) ? (
						<div className="mt-0.5 flex min-h-7 flex-wrap items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
							{visibleAssistantText ? (
								<MessageAction
									label="复制"
									onClick={() =>
										void navigator.clipboard.writeText(visibleAssistantText)
									}
								>
									<Copy className="size-3.5" />
								</MessageAction>
							) : null}
							{canFork ? (
								<MessageAction
									label={forking ? "正在 Fork" : "Fork 新对话"}
									disabled={forkDisabled || forking}
									onClick={() => onFork?.(message.id)}
								>
									{forking ? (
										<LoaderCircle className="size-3.5 animate-spin" />
									) : (
										<GitFork className="size-3.5" />
									)}
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
			<ChatEmptyHero />
		</ConversationColumn>
	);
}
