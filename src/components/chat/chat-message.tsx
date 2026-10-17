import { Fragment, memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Coins, GitFork } from "lucide-react";

import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import {
	AssistantWorkedRegion,
	getAssistantMessageContent,
	renderAssistantContentNodes,
} from "@/components/chat/chat-assistant-work";
import { ChatCopyButton } from "@/components/chat/chat-copy-button";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { hasTokenUsage, type TokenUsage } from "@/lib/api/token-usage";
import {
	getAssistantActivities,
	getAssistantStreamingState,
	splitAssistantContentForDisplay,
	type AssistantContentItem,
} from "@/lib/chat/chat-activity-state";
import type { ChatMessage } from "@/lib/chat/conversation-types";
import { recordChatMessageRender } from "@/lib/chat/chat-performance";
import { formatWorkDuration } from "@/lib/format-duration";
import { formatCompactTokens, formatCost } from "@/lib/format-numbers";
import { getPageFontFamilyStack } from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import { Button, Spinner, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

/**
 * 单轮 token 用量：折叠在消息脚注里只显示合计，悬停展开输入/输出/缓存与费用
 * （该轮最后一次模型调用的用量，与 Pi 的 `usage` 一致）。
 */
function TurnTokenChip({ usage }: { usage: TokenUsage }) {
	const { t } = useTranslation();
	const breakdown: Array<[string, number]> = [
		[t("chat.input"), usage.input],
		[t("chat.output"), usage.output],
		[t("chat.cacheRead"), usage.cacheRead],
		[t("chat.cacheWrite"), usage.cacheWrite],
	];

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="inline-flex cursor-default items-center gap-1 font-mono tabular-nums"
					aria-label={`${t("chat.turnTokens")}: ${formatCompactTokens(usage.total)}`}
				>
					<Coins className="size-3 shrink-0 opacity-70" aria-hidden="true" />
					{formatCompactTokens(usage.total)}
				</span>
			</TooltipTrigger>
			<TooltipContent side="top" className="text-2xs">
				<div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
					<span className="col-span-2 pb-0.5 font-semibold uppercase tracking-[0.6px] text-muted-foreground">
						{t("chat.turnTokens")}
					</span>
					{breakdown.map(([label, value]) => (
						<Fragment key={label}>
							<span className="text-muted-foreground">{label}</span>
							<span className="text-right font-mono tabular-nums">
								{formatCompactTokens(value)}
							</span>
						</Fragment>
					))}
					<span className="border-t border-border/60 pt-0.5 text-muted-foreground">
						{t("chat.tokensTotal")}
					</span>
					<span className="border-t border-border/60 pt-0.5 text-right font-mono tabular-nums">
						{formatCompactTokens(usage.total)}
					</span>
					{usage.cost !== undefined && usage.cost > 0 ? (
						<Fragment>
							<span className="text-muted-foreground">
								{t("chat.turnCost")}
							</span>
							<span className="text-right font-mono tabular-nums">
								{formatCost(usage.cost)}
							</span>
						</Fragment>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
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
					className="size-7 rounded-md text-muted-foreground touch-reveal opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
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
	const { readingFontSize, readingFontFamily, showWorkDuration } =
		usePreferences();
	const content = getAssistantMessageContent(message);
	const activity = getAssistantActivities(content);
	const isTurnFinished =
		message.streaming !== true && message.completion !== "continued";
	const interrupted =
		message.completion === "interrupted" || message.stopReason === "aborted";
	const keepWorkExpanded = !isTurnFinished || interrupted;
	const displaySections = splitAssistantContentForDisplay(
		content,
		!keepWorkExpanded,
		Boolean(message.errorMessage),
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
	const turnUsage = hasTokenUsage(message.usage) ? message.usage : null;
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
		keepWorkExpanded && hasWorkActivity
			? [
					<AssistantWorkedRegion
						key={`${message.id}-worked-active`}
						messageId={message.id}
						content={content}
						active
						streaming={message.streaming === true}
						keepTextExpanded
						durationMs={message.workDurationMs}
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
						keepTextExpanded: keepWorkExpanded,
						durationMs: message.workDurationMs,
					});

	return (
		<ConversationColumn className="group [--chat-assistant-block-padding:0.5rem] py-(--chat-assistant-block-padding) @min-[40rem]:[--chat-assistant-block-padding:0.75rem]">
			<div
				className="w-full text-foreground"
				style={{
					fontSize: `${readingFontSize}px`,
					fontFamily: `var(--pilo-mobile-font-family, ${getPageFontFamilyStack(readingFontFamily)})`,
					minHeight: replyRunwayPx,
				}}
			>
				{/* Layout-neutral headroom lets an empty status satisfy its sticky inset. */}
				<div
					className={
						streamingLabel
							? "relative -mt-1 before:block before:h-1"
							: "relative"
					}
				>
					{contentNodes}
					{visibleErrorMessage ? (
						<div
							role="alert"
							className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
						>
							{visibleErrorMessage}
						</div>
					) : null}
					{streamingLabel || message.stopReason === "aborted" ? (
						<div
							className="mt-1 flex min-h-6 items-center gap-1 text-muted-foreground"
							data-chat-streaming-status={streamingLabel ? "" : undefined}
						>
							{streamingLabel ? (
								<ChatAgentActivityIndicator label={streamingLabel} />
							) : (
								<span className="text-2xs">{t("chat.stopped")}</span>
							)}
						</div>
					) : !visibleErrorMessage &&
					  !message.streaming &&
					  (visibleAssistantText ||
							message.time ||
							footerDuration ||
							turnUsage ||
							canFork) ? (
						<div className="mt-0.5 flex min-h-7 flex-wrap items-center gap-2 text-2xs text-muted-foreground touch-reveal opacity-0 transition-opacity duration-150 group-hover:opacity-100 has-[:focus-visible]:opacity-100">
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
							{turnUsage && (message.time || footerDuration) ? (
								<span aria-hidden="true">·</span>
							) : null}
							{turnUsage ? <TurnTokenChip usage={turnUsage} /> : null}
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
