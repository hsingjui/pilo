import {
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ArrowDown } from "lucide-react";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import {
	AssistantMessage,
	ConversationColumn,
	EmptyConversation,
	UserMessage,
} from "@/components/chat/chat-message";
import { SessionHeader } from "@/components/chat/chat-session-header";
import {
	formatSessionUsage,
	type ChatSession,
} from "@/components/chat/chat-page-utils";
import { ConversationOutlineRail } from "@/components/chat/conversation-outline-rail";
import { useChatConversation } from "@/components/chat/use-chat-conversation";
import { useChatRuntime } from "@/components/chat/use-chat-runtime";
import { useChatScrollController } from "@/components/chat/use-chat-scroll-controller";
import { useChatSessionConfig } from "@/components/chat/use-chat-session-config";
import { createChatSessionClient } from "@/lib/chat-session-client";
import { usePreferences } from "@/lib/preferences-provider";
import {
	Button,
	ErrorState,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

export type { ChatSession } from "@/components/chat/chat-page-utils";

type ChatPageProps = {
	session: ChatSession;
	active?: boolean;
	onSessionIdentified?: (sessionId: string) => void;
	onOpenChanges?: () => void;
	onExpandSidebar?: () => void;
	onSessionChanged?: () => void;
	controllerId?: string;
	uiStateKey?: string;
	readUiState?: (key: string) => ChatUiState;
	writeUiState?: (key: string, patch: ChatUiStatePatch) => void;
	onRuntimeBusyChange?: (controllerId: string, busy: boolean) => void;
	onOpenFile?: (path: string) => void;
	initialMessage?: string;
	loadState?: "ready" | "loading" | "error";
	onRetry?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
};

function ChatPageImpl({
	session,
	active = true,
	onSessionIdentified,
	onOpenChanges,
	onExpandSidebar,
	onSessionChanged,
	controllerId,
	uiStateKey,
	readUiState,
	writeUiState,
	onRuntimeBusyChange,
	onOpenFile,
	initialMessage,
	loadState = "ready",
	onRetry,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: ChatPageProps) {
	const { desktopNotifications } = usePreferences();
	const [initialUiState] = useState<ChatUiState>(() =>
		uiStateKey && readUiState
			? readUiState(uiStateKey)
			: { draft: "", scrollTop: 0, sticky: true },
	);
	const persistDraft = useMemo(
		() =>
			uiStateKey && writeUiState
				? (value: string) => writeUiState(uiStateKey, { draft: value })
				: undefined,
		[uiStateKey, writeUiState],
	);
	const persistScrollState = useMemo(
		() =>
			uiStateKey && writeUiState
				? (state: { scrollTop: number; sticky: boolean }) =>
						writeUiState(uiStateKey, state)
				: undefined,
		[uiStateKey, writeUiState],
	);
	const activeTurnSessionIdRef = useRef<string | null>(null);
	const client = useMemo(
		() =>
			createChatSessionClient(
				session.projectRecord.id,
				session.id,
				session.sessionPath,
			),
		[session.projectRecord.id, session.id, session.sessionPath],
	);
	const {
		sessionState,
		modelOptions,
		selectedModel,
		modelLoadState,
		modelError,
		modelChanging,
		thinkingLevels,
		selectedThinkingLevel,
		thinkingLoading,
		thinkingChanging,
		applyHistoryMetadata,
		handleRenameSession,
		loadModelOptions,
		handleModelChange,
		loadThinkingLevels,
		handleThinkingChange,
		prepareRuntimeConfiguration,
		refreshSessionState,
	} = useChatSessionConfig({
		session,
		client,
		onSessionChanged,
	});
	const {
		baseMessages,
		messages,
		activeAssistantMessageId,
		draft,
		setDraft,
		clearDraft,
		restoreDraftIfEmpty,
		dispatchConversationBatch,
		historyProgress,
		effectiveLoadState,
		historyPending,
		retryHistory,
		refreshHistoryIfStale,
	} = useChatConversation({
		session,
		activeTurnSessionIdRef,
		initialMessage,
		initialDraft: initialUiState.draft,
		loadState,
		onDraftChange: persistDraft,
		onHistoryMetadata: applyHistoryMetadata,
	});
	const {
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
	} = useChatScrollController({
		active,
		sessionId: session.id,
		sessionPath: session.sessionPath,
		messages,
		baseMessages,
		activeAssistantMessageId,
		effectiveLoadState,
		initialScrollTop: initialUiState.scrollTop,
		initialSticky: initialUiState.sticky,
		onScrollStateChange: persistScrollState,
	});
	// 输入区不在滚动容器内，需要补上与滚动条等宽的内边距才能和消息列左右对齐。
	// 固定值在不同平台（overlay / thin / DPI 缩放）下并不一致，所以实测。
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	useLayoutEffect(() => {
		if (!active) return;
		const viewport = scrollRef.current;
		if (!viewport) return;
		const measure = () =>
			setScrollbarWidth(viewport.offsetWidth - viewport.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [active, scrollRef]);
	const {
		activeTurnSessionId,
		activeTurnGeneration,
		pendingSteering,
		pendingFollowUps,
		running,
		runtimeBusy,
		handleSubmit,
		handleSteer,
		handleFollowUp,
		handleStop,
	} = useChatRuntime({
		session,
		client,
		activeTurnSessionIdRef,
		initialMessage,
		desktopNotifications,
		onSessionIdentified,
		dispatchConversationBatch,
		scrollRef,
		scrollToBottom,
		clearDraft,
		restoreDraftIfEmpty,
		prepareRuntimeConfiguration,
		refreshSessionState,
	});

	useEffect(() => {
		if (controllerId) onRuntimeBusyChange?.(controllerId, runtimeBusy);
	}, [controllerId, onRuntimeBusyChange, runtimeBusy]);

	const previousClientRef = useRef(client);
	useEffect(() => {
		const previousClient = previousClientRef.current;
		if (previousClient === client) return;
		previousClientRef.current = client;
		void previousClient.stop().catch(() => undefined);
	}, [client]);

	useEffect(
		() => () => {
			if (controllerId) onRuntimeBusyChange?.(controllerId, false);
		},
		[controllerId, onRuntimeBusyChange],
	);

	useEffect(() => {
		refreshHistoryIfStale(active, activeTurnSessionId);
	}, [active, activeTurnSessionId, refreshHistoryIfStale]);

	const sessionUsageText = formatSessionUsage(sessionState);
	/* oxlint-disable react/refs -- TanStack Virtual intentionally exposes imperative render refs/items; isolate that API at this boundary. */
	const virtualItems = messageVirtualizer.getVirtualItems();
	const virtualizedMessageList = (
		<div ref={messageVirtualizer.containerRef} className="relative min-h-full">
			{virtualItems.map((virtualMessage) => {
				const message = messages[virtualMessage.index];
				if (!message) return null;
				return (
					<div
						key={virtualMessage.key}
						data-index={virtualMessage.index}
						ref={messageVirtualizer.measureElement}
						className="absolute left-0 top-0 w-full"
					>
						{message.role === "user" ? (
							<UserMessage message={message} />
						) : (
							<AssistantMessage
								message={message}
								onOpenFile={onOpenFile}
								replyRunwayPx={
									virtualMessage.index === messages.length - 1
										? message.replyRunwayPx
										: undefined
								}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
	/* oxlint-enable react/refs */

	// Keep the session controller subscribed while its view is in the background.
	if (!active) return null;

	return (
		<div className="flex h-full min-w-0 flex-col bg-background">
			<SessionHeader
				session={session}
				sessionState={sessionState ?? undefined}
				onRename={handleRenameSession}
				onOpenChanges={onOpenChanges}
				onExpandSidebar={onExpandSidebar}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={scrollRef}
					onScroll={syncScrollState}
					className="scrollbar-pro min-h-0 w-full flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
				>
					{effectiveLoadState === "loading" ? (
						<ChatHistorySkeleton />
					) : effectiveLoadState === "error" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<ErrorState
									title="会话加载失败"
									description="暂时无法读取这段会话。"
									onRetry={session.sessionPath ? retryHistory : onRetry}
								/>
							</ConversationColumn>
						</div>
					) : messages.length === 0 ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<EmptyConversation />
						</div>
					) : virtualized ? (
						virtualizedMessageList
					) : (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							{messages.map((message, index) => (
								<div
									key={message.id}
									ref={(node) => {
										if (node) roundRefs.current.set(message.id, node);
										else roundRefs.current.delete(message.id);
									}}
								>
									{message.role === "user" ? (
										<UserMessage message={message} />
									) : (
										<AssistantMessage
											message={message}
											onOpenFile={onOpenFile}
											replyRunwayPx={
												index === messages.length - 1
													? message.replyRunwayPx
													: undefined
											}
										/>
									)}
								</div>
							))}
						</div>
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

				{/* -mt-4 让滚动区底部上探 16px，消息在输入卡背后被自然裁切；
				    裁切线藏在卡片圆角(12px)以内，输入框下方缝隙不会露出消息 */}
				<div
					className="relative -mt-4 w-full shrink-0 pb-4"
					style={{ paddingRight: scrollbarWidth }}
				>
					<ConversationColumn className="relative">
						{!isSticky && messages.length > 0 ? (
							<div className="absolute -top-10 right-3 sm:right-4">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="secondary"
											size="icon"
											className="size-8 rounded-full border border-border/70 shadow-lg transition-[scale] duration-100 active:scale-[0.96]"
											onClick={() => scrollToBottom(true)}
											aria-label="滚动到最新消息"
										>
											<ArrowDown className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>滚动到最新消息</TooltipContent>
								</Tooltip>
							</div>
						) : null}
						<ChatComposer
							value={draft}
							onChange={setDraft}
							onSubmit={handleSubmit}
							onSteer={activeTurnGeneration === null ? undefined : handleSteer}
							onFollowUp={
								activeTurnGeneration === null ? undefined : handleFollowUp
							}
							disabled={
								(runtimeBusy && !running) ||
								effectiveLoadState !== "ready" ||
								historyPending
							}
							running={running}
							onStop={handleStop}
							pendingSteering={pendingSteering}
							pendingFollowUps={pendingFollowUps}
							statusText={historyProgress || sessionUsageText}
							models={modelOptions}
							selectedModel={selectedModel}
							modelLoading={modelLoadState === "loading"}
							modelError={modelError}
							modelDisabled={modelChanging || runtimeBusy || historyPending}
							onModelMenuOpen={() => void loadModelOptions()}
							onModelChange={handleModelChange}
							thinkingLevels={thinkingLevels}
							selectedThinkingLevel={selectedThinkingLevel}
							thinkingLoading={thinkingLoading}
							thinkingDisabled={
								thinkingChanging || runtimeBusy || historyPending
							}
							onThinkingMenuOpen={() => void loadThinkingLevels()}
							onThinkingChange={handleThinkingChange}
						/>
					</ConversationColumn>
				</div>
			</div>
		</div>
	);
}

function chatPagePropsEqual(previous: ChatPageProps, next: ChatPageProps) {
	const previousActive = previous.active ?? true;
	const nextActive = next.active ?? true;

	// Keep inactive conversations mounted so their controller/local state survives,
	// but do not let unrelated App updates execute the entire ChatPage function.
	// React compares again when active changes, so reopening uses the latest props.
	if (!previousActive && !nextActive) return true;

	return false;
}

export const ChatPage = memo(ChatPageImpl, chatPagePropsEqual);
