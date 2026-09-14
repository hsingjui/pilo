import {
	forwardRef,
	memo,
	useCallback,
	useImperativeHandle,
	type MutableRefObject,
} from "react";
import { ArrowDown } from "lucide-react";
import { Virtualizer } from "virtua";

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
import {
	Button,
	ErrorState,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

const CHAT_VIRTUA_BUFFER_PX = 800;

export type ChatConversationViewportHandle = {
	scrollToBottom: (smooth?: boolean) => void;
};

type ChatConversationViewportProps = {
	active: boolean;
	sessionId: string;
	sessionPath?: string;
	messages: ChatMessage[];
	activeAssistantMessageId: string | null;
	effectiveLoadState: "ready" | "loading" | "error";
	initialScrollTop: number;
	initialSticky: boolean;
	onScrollStateChange?: (state: { scrollTop: number; sticky: boolean }) => void;
	runtimeScrollRef: MutableRefObject<HTMLDivElement | null>;
	onOpenFile?: (path: string) => void;
	onRetry?: () => void;
	onRetryHistory: () => void;
};

type MessageRowProps = {
	message: ChatMessage;
	index: number;
	messageCount: number;
	onOpenFile?: (path: string) => void;
};

const MessageRow = memo(function MessageRow({
	message,
	index,
	messageCount,
	onOpenFile,
}: MessageRowProps) {
	return message.role === "user" ? (
		<UserMessage message={message} />
	) : (
		<AssistantMessage
			message={message}
			onOpenFile={onOpenFile}
			replyRunwayPx={
				index === messageCount - 1 ? message.replyRunwayPx : undefined
			}
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
		activeAssistantMessageId,
		effectiveLoadState,
		initialScrollTop,
		initialSticky,
		onScrollStateChange,
		runtimeScrollRef,
		onOpenFile,
		onRetry,
		onRetryHistory,
	},
	ref,
) {
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
		activeAssistantMessageId,
		effectiveLoadState,
		initialScrollTop,
		initialSticky,
		onScrollStateChange,
	});

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
				index={index}
				messageCount={messages.length}
				onOpenFile={onOpenFile}
			/>
		),
		[messages.length, onOpenFile],
	);

	return (
		<ChatExpansionStateProvider>
			<div className="relative min-h-0 w-full flex-1">
				<div
					ref={bindScrollRef}
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
					) : (
						// Virtua already removes off-screen rows. Do not add content-visibility:auto
						// inside message rows: its intrinsic-size placeholders change measured row
						// heights as reverse scrolling reveals content, which causes visible jumps.
						<Virtualizer
							ref={virtualizerRef}
							data={messages}
							shift={false}
							bufferSize={CHAT_VIRTUA_BUFFER_PX}
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
