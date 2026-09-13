import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { ChatMessage } from "@/lib/conversation-types";
import { buildConversationOutline } from "@/lib/conversation-outline";
import {
	getOutlineIndexForMessageIndex,
	shouldVirtualizeChatMessages,
} from "@/lib/chat-virtualization";
import {
	logChatPerformanceInstructions,
	recordChatPageRender,
	recordScrollEvent,
	recordVirtualChange,
} from "@/lib/chat-performance";
import { useChatVirtualPadding } from "@/components/chat/use-chat-virtual-padding";

const CHAT_VIRTUAL_OVERSCAN = 6;
const CHAT_VIRTUAL_SCROLL_PADDING_PX = 16;

type UseChatScrollControllerOptions = {
	active: boolean;
	sessionId: string;
	sessionPath?: string;
	messages: ChatMessage[];
	baseMessages: ChatMessage[];
	activeAssistantMessageId: string | null;
	effectiveLoadState: "ready" | "loading" | "error";
	initialScrollTop?: number;
	initialSticky?: boolean;
	onScrollStateChange?: (state: { scrollTop: number; sticky: boolean }) => void;
};

export function useChatScrollController({
	active,
	sessionId,
	sessionPath,
	messages,
	baseMessages,
	activeAssistantMessageId,
	effectiveLoadState,
	initialScrollTop = 0,
	initialSticky = true,
	onScrollStateChange,
}: UseChatScrollControllerOptions) {
	const outlineRevision = activeAssistantMessageId
		? `${messages.length}:${activeAssistantMessageId}`
		: messages;
	// During an active turn, outline text/weight may lag until structure changes or
	// the turn settles; this avoids rescanning the full conversation on every delta.
	/* oxlint-disable react-hooks/exhaustive-deps */
	const outlineEntries = useMemo(
		() => buildConversationOutline(messages),
		[outlineRevision],
	);
	/* oxlint-enable react-hooks/exhaustive-deps */
	const scrollRef = useRef<HTMLDivElement>(null);
	const scrollPositionRef = useRef(initialScrollTop);
	const restoreScrollPendingRef = useRef(
		!initialSticky && initialScrollTop > 0,
	);
	const roundRefs = useRef(new Map<string, HTMLDivElement>());
	const messagesRef = useRef(messages);
	useLayoutEffect(() => {
		messagesRef.current = messages;
	}, [messages]);
	const virtualPadding = useChatVirtualPadding();
	const virtualized =
		active &&
		effectiveLoadState === "ready" &&
		shouldVirtualizeChatMessages(messages.length);
	recordChatPageRender(sessionId, messages.length, virtualized);
	const getVirtualMessageKey = useCallback(
		(index: number) =>
			`${sessionId}:${messagesRef.current[index]?.id ?? index}`,
		[sessionId],
	);
	const estimateVirtualMessageSize = useCallback(
		(index: number) => (messagesRef.current[index]?.role === "user" ? 84 : 184),
		[],
	);
	/* oxlint-disable-next-line react/incompatible-library -- TanStack Virtual intentionally owns imperative measurement and scroll functions; keep the virtualizer local to this hook. */
	const messageVirtualizer = useVirtualizer({
		count: messages.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: estimateVirtualMessageSize,
		getItemKey: getVirtualMessageKey,
		overscan: CHAT_VIRTUAL_OVERSCAN,
		paddingStart: virtualPadding.start,
		paddingEnd: virtualPadding.end,
		scrollPaddingStart: CHAT_VIRTUAL_SCROLL_PADDING_PX,
		useAnimationFrameWithResizeObserver: true,
		directDomUpdates: true,
		onChange: (instance, sync) => {
			const range = instance.range;
			recordVirtualChange({
				sync,
				startIndex: range?.startIndex ?? null,
				endIndex: range?.endIndex ?? null,
				totalSize: instance.getTotalSize(),
			});
		},
		enabled: virtualized,
	});
	const stickyRef = useRef(initialSticky);
	const onScrollStateChangeRef = useRef(onScrollStateChange);
	onScrollStateChangeRef.current = onScrollStateChange;
	const scrollSyncFrameRef = useRef<number | null>(null);
	const [isSticky, setIsSticky] = useState(initialSticky);
	const isScrolledFromTopRef = useRef(initialScrollTop > 16);
	const [isScrolledFromTop, setIsScrolledFromTop] = useState(
		initialScrollTop > 16,
	);
	const [activeOutlineIndex, setActiveOutlineIndex] = useState(
		outlineEntries.length ? outlineEntries.length - 1 : -1,
	);
	const activeOutlineIndexRef = useRef(activeOutlineIndex);
	activeOutlineIndexRef.current = activeOutlineIndex;

	const syncScrollState = useCallback(() => {
		recordScrollEvent();
		const viewport = scrollRef.current;
		if (!viewport) return;
		scrollPositionRef.current = viewport.scrollTop;
		if (scrollSyncFrameRef.current !== null) return;

		scrollSyncFrameRef.current = requestAnimationFrame(() => {
			scrollSyncFrameRef.current = null;
			const currentViewport = scrollRef.current;
			if (!currentViewport) return;

			const distanceFromBottom =
				currentViewport.scrollHeight -
				currentViewport.clientHeight -
				currentViewport.scrollTop;
			const nextSticky = distanceFromBottom <= 72;
			if (stickyRef.current !== nextSticky) {
				stickyRef.current = nextSticky;
				setIsSticky(nextSticky);
			}
			onScrollStateChangeRef.current?.({
				scrollTop: currentViewport.scrollTop,
				sticky: nextSticky,
			});
			const nextScrolledFromTop = currentViewport.scrollTop > 16;
			if (isScrolledFromTopRef.current !== nextScrolledFromTop) {
				isScrolledFromTopRef.current = nextScrolledFromTop;
				setIsScrolledFromTop(nextScrolledFromTop);
			}

			if (outlineEntries.length === 0) {
				if (activeOutlineIndexRef.current !== -1) {
					activeOutlineIndexRef.current = -1;
					setActiveOutlineIndex(-1);
				}
				return;
			}
			if (distanceFromBottom <= 2) {
				const nextIndex = outlineEntries.length - 1;
				if (activeOutlineIndexRef.current !== nextIndex) {
					activeOutlineIndexRef.current = nextIndex;
					setActiveOutlineIndex(nextIndex);
				}
				return;
			}
			const readingLine = currentViewport.scrollTop + 72;
			if (virtualized) {
				const readingItem =
					messageVirtualizer.getVirtualItemForOffset(readingLine);
				const nextIndex = getOutlineIndexForMessageIndex(
					outlineEntries,
					readingItem?.index ?? 0,
				);
				if (activeOutlineIndexRef.current !== nextIndex) {
					activeOutlineIndexRef.current = nextIndex;
					setActiveOutlineIndex(nextIndex);
				}
				return;
			}

			let nextIndex = 0;
			for (let index = 0; index < outlineEntries.length; index += 1) {
				const row = roundRefs.current.get(outlineEntries[index].key);
				if (!row || row.offsetTop > readingLine) break;
				nextIndex = index;
			}
			if (activeOutlineIndexRef.current !== nextIndex) {
				activeOutlineIndexRef.current = nextIndex;
				setActiveOutlineIndex(nextIndex);
			}
		});
	}, [messageVirtualizer, outlineEntries, virtualized]);

	useEffect(() => {
		logChatPerformanceInstructions();
	}, []);

	useEffect(
		() => () => {
			if (scrollSyncFrameRef.current !== null) {
				cancelAnimationFrame(scrollSyncFrameRef.current);
			}
			onScrollStateChangeRef.current?.({
				scrollTop: scrollPositionRef.current,
				sticky: stickyRef.current,
			});
		},
		[],
	);

	const scrollToBottom = useCallback((smooth = true) => {
		const viewport = scrollRef.current;
		if (!viewport) return;
		viewport.scrollTo({
			top: viewport.scrollHeight,
			behavior: smooth ? "smooth" : "auto",
		});
		stickyRef.current = true;
		setIsSticky(true);
	}, []);

	useEffect(() => {
		if (!sessionId || !active) return;
		const frame = requestAnimationFrame(() => {
			if (stickyRef.current) scrollToBottom(false);
			else scrollRef.current?.scrollTo({ top: scrollPositionRef.current });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, sessionId, scrollToBottom]);

	useEffect(() => {
		if (
			!active ||
			!restoreScrollPendingRef.current ||
			effectiveLoadState !== "ready" ||
			messages.length === 0
		) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			const viewport = scrollRef.current;
			if (!viewport) return;
			viewport.scrollTo({ top: scrollPositionRef.current });
			restoreScrollPendingRef.current = false;
			syncScrollState();
		});
		return () => cancelAnimationFrame(frame);
	}, [active, effectiveLoadState, messages.length, syncScrollState]);

	useEffect(() => {
		if (!sessionPath || !stickyRef.current) return;
		const frame = requestAnimationFrame(() => scrollToBottom(false));
		return () => cancelAnimationFrame(frame);
	}, [baseMessages, sessionPath, scrollToBottom]);

	const lastMessage = messages[messages.length - 1];
	const streamingMessage =
		lastMessage?.role === "assistant" && lastMessage.streaming
			? lastMessage
			: null;
	useEffect(() => {
		if (!stickyRef.current || streamingMessage === null) return;
		const frame = requestAnimationFrame(() => scrollToBottom(false));
		return () => cancelAnimationFrame(frame);
	}, [streamingMessage, scrollToBottom]);

	const handleOutlineJump = useCallback(
		(index: number) => {
			const entry = outlineEntries[index];
			const viewport = scrollRef.current;
			if (!entry || !viewport) return;
			stickyRef.current = false;
			if (isSticky) setIsSticky(false);
			activeOutlineIndexRef.current = index;
			setActiveOutlineIndex(index);

			if (virtualized) {
				messageVirtualizer.scrollToIndex(entry.messageIndex, {
					align: "start",
				});
				return;
			}

			const row = roundRefs.current.get(entry.key);
			if (!row) return;
			viewport.scrollTo({
				top: Math.max(0, row.offsetTop - CHAT_VIRTUAL_SCROLL_PADDING_PX),
				behavior: "smooth",
			});
		},
		[isSticky, messageVirtualizer, outlineEntries, virtualized],
	);

	return {
		outlineEntries,
		scrollRef,
		roundRefs,
		virtualized,
		messageVirtualizer,
		isSticky,
		isScrolledFromTop,
		activeOutlineIndex,
		syncScrollState,
		scrollToBottom,
		handleOutlineJump,
	};
}
