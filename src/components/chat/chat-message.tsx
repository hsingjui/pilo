import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GitFork } from "lucide-react";

import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import {
	AssistantWorkedRegion,
	getAssistantMessageContent,
	renderAssistantContentNodes,
} from "@/components/chat/chat-assistant-work";
import { ChatCopyButton } from "@/components/chat/chat-copy-button";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import {
	getAssistantActivities,
	getAssistantStreamingState,
	splitAssistantContentForDisplay,
	type AssistantContentItem,
} from "@/lib/chat-activity-state";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatMessageRender } from "@/lib/chat-performance";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { Button, Spinner, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

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

export const AssistantMessage = memo(function AssistantMessage({
	message,
	replyRunwayPx,
	onFork,
	forking = false,
	forkDisabled = false,
	suppressInterruptedError = false,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	replyRunwayPx?: number;
	onFork?: (messageId: string) => void;
	forking?: boolean;
	forkDisabled?: boolean;
	suppressInterruptedError?: boolean;
}) {
	recordChatMessageRender("assistant");
	const { t } = useTranslation();
	const { pageFontSize, showWorkDuration } = usePreferences();
	const content = getAssistantMessageContent(message);
	const activity = getAssistantActivities(content);
	const isTurnFinished =
		message.streaming !== true && message.completion !== "continued";
	const foldWorkOnError =
		Boolean(message.errorMessage) ||
		message.completion === "interrupted" ||
		message.stopReason === "aborted";
	const displaySections = splitAssistantContentForDisplay(
		content,
		isTurnFinished,
		foldWorkOnError,
	);
	const streamingState = getAssistantStreamingState({
		text: message.text,
		activity,
		streaming: message.streaming,
	});
	const streamingLabel = streamingState ? t(`chat.${streamingState}`) : null;
	const hasWorkActivity = activity.length > 0;
	const workDurationOwnedByContent =
		hasWorkActivity || displaySections.hasCollapsedWork;
	const collapsedWorkFollowedByText = displaySections.final.some(
		(item) => item.type === "text" && item.text.length > 0,
	);
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
			? formatWorkDuration(message.workDurationMs, {
					hour: t("common.hour"),
					minute: t("common.minute"),
					second: t("common.second"),
				})
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
	const contentNodes =
		!isTurnFinished && hasWorkActivity
			? [
					<AssistantWorkedRegion
						key={`${message.id}-worked-active`}
						messageId={message.id}
						content={content}
						active
						streaming={message.streaming === true}
						keepTextExpanded
					/>,
				]
			: displaySections.hasCollapsedWork
				? [
						<AssistantWorkedRegion
							key={`${message.id}-worked-complete`}
							messageId={message.id}
							content={displaySections.work}
							durationMs={message.workDurationMs}
							followedByTextAfterContent={collapsedWorkFollowedByText}
						/>,
						...renderAssistantContentNodes({
							messageId: message.id,
							content: displaySections.final,
							streaming: message.streaming === true,
						}),
					]
				: renderAssistantContentNodes({
						messageId: message.id,
						content,
						streaming: message.streaming === true,
						keepTextExpanded: !isTurnFinished,
						durationMs: message.workDurationMs,
					});

	return (
		<ConversationColumn className="group py-2 @min-[40rem]:py-3">
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
						<div className="mt-1 flex min-h-6 items-center gap-1 text-2xs text-muted-foreground">
							{streamingLabel ? (
								<ChatAgentActivityIndicator label={streamingLabel} />
							) : visibleErrorMessage ? (
								<span className="text-destructive">
									{t("chat.responseFailed")}
								</span>
							) : (
								<span>{t("chat.stopped")}</span>
							)}
						</div>
					) : !message.streaming &&
					  (visibleAssistantText ||
							message.time ||
							footerDuration ||
							canFork) ? (
						<div className="mt-0.5 flex min-h-7 flex-wrap items-center gap-2 text-2xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
							{visibleAssistantText ? (
								<ChatCopyButton text={visibleAssistantText} />
							) : null}
							{canFork ? (
								<MessageAction
									label={forking ? t("chat.forking") : t("chat.forkNewSession")}
									disabled={forkDisabled || forking}
									onClick={() => onFork?.(message.id)}
								>
									{forking ? (
										<Spinner className="size-3.5" />
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
