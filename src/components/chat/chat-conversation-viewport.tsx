import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react";
import { Virtualizer, type CacheSnapshot } from "virtua";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import { ChatExpansionStateProvider } from "@/components/chat/chat-expansion-state";
import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import { EmptyConversation } from "@/components/chat/chat-message";
import { MessageRow } from "@/components/chat/chat-message-row";
import { SwitchSkeletonOverlay } from "@/components/chat/chat-switch-skeleton";
import { ConversationOutlineRail } from "@/components/chat/conversation-outline-rail";
import { useChatScrollController } from "@/components/chat/use-chat-scroll-controller";
import type { ChatMessage } from "@/lib/conversation-types";
import { recordChatSessionSwitchReady } from "@/lib/chat-performance";
import { cn } from "@/lib/utils";
import {
	shouldInitializeShortChatPromoted,
	shouldPromoteShortChatVirtualization,
	shouldRenderPlainShortChat,
} from "@/lib/chat-virtualization";
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

export type ChatConversationViewportHandle = {
	scrollToBottom: (smooth?: boolean) => void;
	scrollToMessageIndex: (messageIndex: number) => void;
};

type ChatConversationViewportProps = {
	active: boolean;
	visualLive: boolean;
	showSwitchSkeleton?: boolean;
	sessionId: string;
	sessionPath?: string;
	messages: ChatMessage[];
	onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
	activeAssistantMessageId: string | null;
	compacting?: boolean;
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
	onForkAssistant?: (messageId: string) => void;
	forkingMessageId?: string | null;
	forkDisabled?: boolean;
	suppressInterruptedError?: boolean;
	onVisualReady?: () => void;
	onRetry?: () => void;
	onRetryHistory: () => void;
};

const ChatConversationViewportImpl = forwardRef<
	ChatConversationViewportHandle,
	ChatConversationViewportProps
>(function ChatConversationViewport(
	{
		active,
		visualLive,
		showSwitchSkeleton = false,
		sessionId,
		sessionPath,
		messages,
		onVisibleRangeChange,
		activeAssistantMessageId,
		compacting = false,
		effectiveLoadState,
		initialScrollTop,
		initialSticky,
		initialVirtualizerCache,
		onScrollStateChange,
		onVirtualizerCacheChange,
		runtimeScrollRef,
		onForkAssistant,
		forkingMessageId,
		forkDisabled,
		suppressInterruptedError,
		onVisualReady,
		onRetry,
		onRetryHistory,
	},
	ref,
) {
	const { t } = useTranslation();
	const [shortChatPromoted, setShortChatPromoted] = useState(() =>
		shouldInitializeShortChatPromoted({
			enabled: USE_PLAIN_SHORT_CHAT,
			messageCount: messages.length,
			streaming: activeAssistantMessageId !== null,
		}),
	);
	const [viewportSticky, setViewportSticky] = useState(initialSticky);
	const viewportStickyRef = useRef(initialSticky);
	const visualReadyReportedRef = useRef(false);
	const plainShortChat = shouldRenderPlainShortChat({
		enabled: USE_PLAIN_SHORT_CHAT,
		promoted: shortChatPromoted,
	});
	const handleScrollStateChange = useCallback(
		(state: { scrollTop: number; sticky: boolean }) => {
			if (viewportStickyRef.current !== state.sticky) {
				viewportStickyRef.current = state.sticky;
				setViewportSticky(state.sticky);
			}
			onScrollStateChange?.(state);
		},
		[onScrollStateChange],
	);
	const shortChatPromotionPending = shouldPromoteShortChatVirtualization({
		enabled: USE_PLAIN_SHORT_CHAT,
		promoted: shortChatPromoted,
		active,
		ready: effectiveLoadState === "ready",
		messageCount: messages.length,
		streaming: activeAssistantMessageId !== null,
		sticky: viewportSticky,
		preparingVisual: showSwitchSkeleton,
	});

	useEffect(() => {
		if (!shortChatPromotionPending) return;
		// A cold visual is hidden behind the switch skeleton, so finish the
		// plain-chat -> Virtua handoff immediately while it is still invisible.
		// Warm/live chats keep the idle promotion path to avoid disturbing an
		// interaction that is already visible to the user.
		if (showSwitchSkeleton) {
			const frame = requestAnimationFrame(() => setShortChatPromoted(true));
			return () => cancelAnimationFrame(frame);
		}

		const idleWindow = window as Window & {
			requestIdleCallback?: (
				callback: () => void,
				options?: { timeout: number },
			) => number;
			cancelIdleCallback?: (handle: number) => void;
		};
		if (idleWindow.requestIdleCallback) {
			const handle = idleWindow.requestIdleCallback(
				() => setShortChatPromoted(true),
				{ timeout: 750 },
			);
			return () => idleWindow.cancelIdleCallback?.(handle);
		}
		const timer = window.setTimeout(() => setShortChatPromoted(true), 200);
		return () => window.clearTimeout(timer);
	}, [shortChatPromotionPending, showSwitchSkeleton]);

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
		showScrollToLatest,
		isScrolledFromTop,
		activeOutlineIndex,
		syncScrollState,
		scrollToBottom,
		handleOutlineJump,
		jumpToMessageIndex,
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
		onScrollStateChange: handleScrollStateChange,
		onVisibleRangeChange,
		onVirtualizerCacheChange,
	});

	useLayoutEffect(() => {
		if (!active || !visualLive) {
			visualReadyReportedRef.current = false;
			return;
		}
		if (visualReadyReportedRef.current) return;
		if (effectiveLoadState === "loading" || shortChatPromotionPending) return;

		const reportReady = () => {
			if (visualReadyReportedRef.current) return;
			visualReadyReportedRef.current = true;
			recordChatSessionSwitchReady(sessionId);
			onVisualReady?.();
		};
		if (effectiveLoadState === "error" || messages.length === 0) {
			reportReady();
			return;
		}

		const viewport = runtimeScrollRef.current;
		if (!viewport) return;
		let frame: number | null = null;
		let stableFrames = 0;
		let previousGeometry = "";
		const checkReady = () => {
			const childCount = viewport.firstElementChild?.childElementCount ?? 0;
			const hasPaintableRows = childCount > 0;
			const visibleHistoryPending = Boolean(
				viewport.querySelector('[data-history-placeholder="true"]'),
			);
			const maxScrollTop = Math.max(
				0,
				viewport.scrollHeight - viewport.clientHeight,
			);
			const targetScrollTop = initialSticky
				? maxScrollTop
				: Math.min(initialScrollTop, maxScrollTop);
			const scrollRestored =
				Math.abs(viewport.scrollTop - targetScrollTop) <= 2;
			const geometry = `${Math.round(viewport.scrollTop)}:${Math.round(
				viewport.scrollHeight,
			)}:${childCount}`;
			if (hasPaintableRows && scrollRestored && !visibleHistoryPending) {
				stableFrames = geometry === previousGeometry ? stableFrames + 1 : 1;
				previousGeometry = geometry;
				if (stableFrames >= 2) {
					reportReady();
					return;
				}
			} else {
				stableFrames = 0;
				previousGeometry = "";
			}
			frame = requestAnimationFrame(checkReady);
		};
		frame = requestAnimationFrame(checkReady);
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [
		active,
		effectiveLoadState,
		initialScrollTop,
		initialSticky,
		messages.length,
		onVisualReady,
		runtimeScrollRef,
		sessionId,
		shortChatPromotionPending,
		visualLive,
	]);

	useImperativeHandle(
		ref,
		() => ({ scrollToBottom, scrollToMessageIndex: jumpToMessageIndex }),
		[scrollToBottom, jumpToMessageIndex],
	);

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
			suppressInterruptedError,
		],
	);

	return (
		<ChatExpansionStateProvider>
			<div className="relative isolate min-h-0 w-full flex-1">
				<div
					ref={bindScrollRef}
					aria-hidden={showSwitchSkeleton || undefined}
					onScroll={
						plainShortChat
							? (event) => syncScrollState(event.currentTarget.scrollTop)
							: undefined
					}
					className={cn(
						"chat-scrollbar h-full w-full overflow-x-hidden overflow-y-auto overscroll-none [contain:strict]",
						showSwitchSkeleton && "invisible",
					)}
					// scrollbar-gutter: stable 由 .chat-scrollbar 统一提供且恒定，
					// composer 据此对齐（chat-page.tsx）；这里不再按消息数来回切换。
					style={
						effectiveLoadState === "ready" && messages.length > 0
							? {
									paddingTop: virtualPadding.start,
									paddingBottom: virtualPadding.end,
								}
							: undefined
					}
				>
					{effectiveLoadState === "loading" ? (
						<ChatHistorySkeleton />
					) : effectiveLoadState === "error" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 @min-[40rem]:pb-10 @min-[40rem]:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<ErrorState
									title={t("chat.sessionLoadFailed")}
									description={t("chat.sessionLoadDescription")}
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
							startMargin={virtualPadding.start}
							shift={false}
							bufferSize={CHAT_VIRTUA_BUFFER_PX}
							keepMounted={keepMounted}
							onScroll={handleVirtualScroll}
							onScrollEnd={handleScrollEnd}
						>
							{renderMessage}
						</Virtualizer>
					)}
					{compacting ? (
						<ConversationColumn className="py-3">
							<ChatAgentActivityIndicator label={t("chat.compacting")} />
						</ConversationColumn>
					) : null}
				</div>

				{/* 与被覆盖的滚动区同样预留 stable gutter，切换骨架的列宽
				    才和下方的消息列/输入框一致，撤掉覆盖层时不横跳。 */}
				<SwitchSkeletonOverlay covering={showSwitchSkeleton} />

				{!showSwitchSkeleton && isScrolledFromTop ? (
					<div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-background to-transparent" />
				) : null}

				{!showSwitchSkeleton ? (
					<ConversationOutlineRail
						entries={outlineEntries}
						activeIndex={activeOutlineIndex}
						onJumpToRound={handleOutlineJump}
					/>
				) : null}

				{!showSwitchSkeleton && showScrollToLatest && messages.length > 0 ? (
					<ConversationColumn className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-end">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="secondary"
									size="icon"
									className="pointer-events-auto size-8 rounded-full border border-border/70 shadow-md transition-[scale] duration-100 active:scale-[0.96]"
									onClick={() => scrollToBottom(false)}
									aria-label={t("chat.scrollLatest")}
								>
									<ArrowDown className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("chat.scrollLatest")}</TooltipContent>
						</Tooltip>
					</ConversationColumn>
				) : null}
			</div>
		</ChatExpansionStateProvider>
	);
});

export const ChatConversationViewport = memo(ChatConversationViewportImpl);
