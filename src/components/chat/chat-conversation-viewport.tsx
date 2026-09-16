import {
	forwardRef,
	memo,
	useCallback,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	type MutableRefObject,
} from "react";
import { ArrowDown } from "lucide-react";
import { Virtualizer, type CacheSnapshot } from "virtua";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { ChatExpansionStateProvider } from "@/components/chat/chat-expansion-state";
import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import {
	AssistantMessage,
	EmptyConversation,
} from "@/components/chat/chat-message";
import { UserMessage } from "@/components/chat/chat-user-message";
import { ConversationOutlineRail } from "@/components/chat/conversation-outline-rail";
import { useChatScrollController } from "@/components/chat/use-chat-scroll-controller";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatSessionSwitchReady } from "@/lib/chat-performance";
import {
	Button,
	ErrorState,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

const CHAT_VIRTUA_BUFFER_PX = 800;
// Virtualization pays off for long history, but a short conversation with one
// rapidly growing assistant row is cheaper and more stable in normal document
// flow. Keep an opt-out for regression comparisons.
const USE_PLAIN_SHORT_CHAT = import.meta.env.VITE_PILO_PLAIN_SHORT_CHAT !== "0";
const PLAIN_SHORT_CHAT_MAX_MESSAGES = 8;

export type ChatConversationViewportHandle = {
	scrollToBottom: (smooth?: boolean) => void;
};

type ChatConversationViewportProps = {
	active: boolean;
	sessionId: string;
	sessionPath?: string;
	messages: ChatMessage[];
	onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
	activeAssistantMessageId: string | null;
	effectiveLoadState: "ready" | "loading" | "error";
	initialScrollTop: number;
	initialSticky: boolean;
	initialVirtualizerCache?: CacheSnapshot;
	onScrollStateChange?: (state: { scrollTop: number; sticky: boolean }) => void;
	onVirtualizerCacheChange?: (
		cache: CacheSnapshot,
		messageCount: number,
	) => void;
	runtimeScrollRef: MutableRefObject<HTMLDivElement | null>;
	onOpenFile?: (path: string) => void;
	onForkAssistant?: (messageId: string) => void;
	forkingMessageId?: string | null;
	forkDisabled?: boolean;
	suppressInterruptedError?: boolean;
	onRetry?: () => void;
	onRetryHistory: () => void;
};

type MessageRowProps = {
	message: ChatMessage;
	isLastMessage: boolean;
	onOpenFile?: (path: string) => void;
	onForkAssistant?: (messageId: string) => void;
	forkingMessageId?: string | null;
	forkDisabled?: boolean;
	suppressInterruptedError?: boolean;
};

function HistoryMessagePlaceholder({ message }: { message: ChatMessage }) {
	const estimatedChars = message.historyEstimatedChars ?? message.text.length;
	const estimatedHeight =
		message.role === "user"
			? Math.min(152, 52 + Math.ceil(estimatedChars / 90) * 20)
			: Math.min(360, 72 + Math.ceil(estimatedChars / 110) * 20);
	return (
		<ConversationColumn className="py-2 sm:py-3">
			<div
				className={
					message.role === "user"
						? "ml-auto w-[min(70%,28rem)] rounded-2xl border border-foreground/[0.05] bg-foreground/[0.025]"
						: "w-full rounded-lg bg-foreground/[0.018]"
				}
				style={{ minHeight: estimatedHeight }}
				aria-hidden="true"
			/>
		</ConversationColumn>
	);
}

const MessageRow = memo(function MessageRow({
	message,
	isLastMessage,
	onOpenFile,
	onForkAssistant,
	forkingMessageId,
	forkDisabled,
	suppressInterruptedError,
}: MessageRowProps) {
	if (message.historyPlaceholder) {
		return <HistoryMessagePlaceholder message={message} />;
	}
	return message.role === "user" ? (
		<UserMessage message={message} />
	) : (
		<AssistantMessage
			message={message}
			onOpenFile={onOpenFile}
			onFork={onForkAssistant}
			forking={forkingMessageId === message.id}
			forkDisabled={forkDisabled}
			suppressInterruptedError={
				Boolean(suppressInterruptedError) && isLastMessage
			}
			replyRunwayPx={isLastMessage ? message.replyRunwayPx : undefined}
		/>
	);
});

const ChatConversationViewportImpl = forwardRef<
	ChatConversationViewportHandle,
	ChatConversationViewportProps
>(function ChatConversationViewport(
	{
		active,
		sessionId,
		sessionPath,
		messages,
		onVisibleRangeChange,
		activeAssistantMessageId,
		effectiveLoadState,
		initialScrollTop,
		initialSticky,
		initialVirtualizerCache,
		onScrollStateChange,
		onVirtualizerCacheChange,
		runtimeScrollRef,
		onOpenFile,
		onForkAssistant,
		forkingMessageId,
		forkDisabled,
		suppressInterruptedError,
		onRetry,
		onRetryHistory,
	},
	ref,
) {
	const plainShortChat =
		USE_PLAIN_SHORT_CHAT && messages.length <= PLAIN_SHORT_CHAT_MAX_MESSAGES;
	const keepMounted = useMemo(() => {
		if (!activeAssistantMessageId) return undefined;
		const lastIndex = messages.length - 1;
		if (messages[lastIndex]?.id === activeAssistantMessageId)
			return [lastIndex];
		const index = messages.findIndex(
			(message) => message.id === activeAssistantMessageId,
		);
		return index >= 0 ? [index] : undefined;
	}, [activeAssistantMessageId, messages]);
	const {
		outlineEntries,
		scrollRef,
		virtualizerRef,
		virtualPadding,
		isSticky,
		isScrolledFromTop,
		activeOutlineIndex,
		syncScrollState,
		scrollToBottom,
		handleOutlineJump,
		handleScrollEnd,
	} = useChatScrollController({
		active,
		sessionId,
		messages,
		virtualizerEnabled: !plainShortChat,
		activeAssistantMessageId,
		effectiveLoadState,
		initialScrollTop,
		initialSticky,
		onScrollStateChange,
		onVisibleRangeChange,
		onVirtualizerCacheChange,
	});

	useLayoutEffect(() => {
		if (active && effectiveLoadState === "ready") {
			recordChatSessionSwitchReady(sessionId);
		}
	}, [active, effectiveLoadState, sessionId]);

	useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

	const bindScrollRef = useCallback(
		(node: HTMLDivElement | null) => {
			scrollRef(node);
			runtimeScrollRef.current = node;
		},
		[runtimeScrollRef, scrollRef],
	);
	const handleVirtualScroll = useCallback(
		(offset: number) => syncScrollState(offset),
		[syncScrollState],
	);
	const renderMessage = useCallback(
		(message: ChatMessage, index: number) => (
			<MessageRow
				key={message.id}
				message={message}
				isLastMessage={index === messages.length - 1}
				onOpenFile={onOpenFile}
				onForkAssistant={onForkAssistant}
				forkingMessageId={forkingMessageId}
				forkDisabled={forkDisabled}
				suppressInterruptedError={suppressInterruptedError}
			/>
		),
		[
			forkDisabled,
			forkingMessageId,
			messages.length,
			onForkAssistant,
			onOpenFile,
			suppressInterruptedError,
		],
	);

	return (
		<ChatExpansionStateProvider>
			<div className="relative min-h-0 w-full flex-1">
				<div
					ref={bindScrollRef}
					onScroll={
						plainShortChat
							? (event) => syncScrollState(event.currentTarget.scrollTop)
							: undefined
					}
					className="chat-scrollbar h-full w-full overflow-x-hidden overflow-y-auto overscroll-none [contain:strict]"
					style={{
						scrollbarGutter:
							effectiveLoadState === "ready" && messages.length === 0
								? "auto"
								: "stable",
						...(effectiveLoadState === "ready" && messages.length > 0
							? {
									paddingTop: virtualPadding.start,
									paddingBottom: virtualPadding.end,
								}
							: {}),
					}}
				>
					{effectiveLoadState === "loading" ? (
						<ChatHistorySkeleton />
					) : effectiveLoadState === "error" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<ErrorState
									title="会话加载失败"
									description="暂时无法读取这段会话。"
									onRetry={sessionPath ? onRetryHistory : onRetry}
								/>
							</ConversationColumn>
						</div>
					) : messages.length === 0 ? (
						<div className="flex min-h-full flex-col">
							<EmptyConversation />
						</div>
					) : plainShortChat ? (
						<div>
							{messages.map((message, index) => renderMessage(message, index))}
						</div>
					) : (
						// Virtua already removes off-screen rows. Do not add content-visibility:auto
						// inside message rows: its intrinsic-size placeholders change measured row
						// heights as reverse scrolling reveals content, which causes visible jumps.
						<Virtualizer
							ref={virtualizerRef}
							data={messages}
							cache={initialVirtualizerCache}
							shift={false}
							bufferSize={CHAT_VIRTUA_BUFFER_PX}
							keepMounted={keepMounted}
							onScroll={handleVirtualScroll}
							onScrollEnd={handleScrollEnd}
						>
							{renderMessage}
						</Virtualizer>
					)}
				</div>

				{isScrolledFromTop ? (
					<div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-background to-transparent" />
				) : null}

				<ConversationOutlineRail
					entries={outlineEntries}
					activeIndex={activeOutlineIndex}
					onJumpToRound={handleOutlineJump}
				/>

				{!isSticky && messages.length > 0 ? (
					<ConversationColumn className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-end">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="secondary"
									size="icon"
									className="pointer-events-auto size-8 rounded-full border border-border/70 shadow-lg transition-[scale] duration-100 active:scale-[0.96]"
									onClick={() => scrollToBottom(false)}
									aria-label="滚动到最新消息"
								>
									<ArrowDown className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>滚动到最新消息</TooltipContent>
						</Tooltip>
					</ConversationColumn>
				) : null}
			</div>
		</ChatExpansionStateProvider>
	);
});

export const ChatConversationViewport = memo(ChatConversationViewportImpl);
