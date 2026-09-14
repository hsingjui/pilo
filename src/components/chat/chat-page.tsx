import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import {
	ChatConversationViewport,
	type ChatConversationViewportHandle,
} from "@/components/chat/chat-conversation-viewport";
import { ChatPendingQueue } from "@/components/chat/chat-pending-queue";
import { SessionHeader } from "@/components/chat/chat-session-header";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import {
	routeInitialDeferredSubmissions,
	shouldDeferSubmissionUntilHistoryReady,
} from "@/components/chat/chat-submission-state";
import { useChatConversation } from "@/components/chat/use-chat-conversation";
import { useChatRuntime } from "@/components/chat/use-chat-runtime";
import { useChatSessionConfig } from "@/components/chat/use-chat-session-config";
import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	createChatSubmission,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { toast } from "sonner";

export type { ChatSession } from "@/components/chat/chat-page-utils";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

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
	initialImages?: readonly ChatImageAttachment[];
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
	initialImages = EMPTY_CHAT_IMAGES,
	loadState = "ready",
	onRetry,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: ChatPageProps) {
	const { desktopNotifications, keyboardShortcuts } = usePreferences();
	const [initialUiState] = useState<ChatUiState>(() =>
		uiStateKey && readUiState
			? readUiState(uiStateKey)
			: { draft: "", scrollTop: 0, sticky: true, deferredSubmissions: [] },
	);
	const initialDeferredSubmissions = useMemo(
		() =>
			routeInitialDeferredSubmissions(
				session.sessionPath,
				initialUiState.deferredSubmissions,
			),
		[initialUiState.deferredSubmissions, session.sessionPath],
	);
	useEffect(() => {
		if (
			session.sessionPath ||
			!uiStateKey ||
			!writeUiState ||
			initialUiState.deferredSubmissions.length === 0
		) {
			return;
		}
		// New chats hand the fallback queue directly to the runtime. Existing-session
		// queues stay persisted until history is ready and the page actually drains them.
		writeUiState(uiStateKey, { deferredSubmissions: [] });
	}, [
		initialUiState.deferredSubmissions,
		session.sessionPath,
		uiStateKey,
		writeUiState,
	]);
	const persistDraft = useMemo(
		() =>
			uiStateKey && writeUiState
				? (value: string) => writeUiState(uiStateKey, { draft: value })
				: undefined,
		[uiStateKey, writeUiState],
	);
	const persistScrollState = useCallback(
		(state: { scrollTop: number; sticky: boolean }) => {
			if (uiStateKey && writeUiState) writeUiState(uiStateKey, state);
		},
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
		handleQuickCycleModel,
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
		messages,
		pendingUsers,
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
		initialImages,
		initialDraft: initialUiState.draft,
		loadState,
		onDraftChange: persistDraft,
		onHistoryMetadata: applyHistoryMetadata,
	});
	const scrollRef = useRef<HTMLDivElement>(null);
	const conversationViewportRef = useRef<ChatConversationViewportHandle>(null);
	const scrollToBottom = useCallback((smooth = true) => {
		conversationViewportRef.current?.scrollToBottom(smooth);
	}, []);
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
	const pendingHistorySubmissionsRef = useRef<string[]>(
		initialDeferredSubmissions.history,
	);
	const [composerImages, setComposerImages] = useState<ChatImageAttachment[]>(
		[],
	);
	const {
		activeTurnSessionId,
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
		initialImages,
		initialQueuedMessages: initialDeferredSubmissions.runtime,
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

	const historySubmissionBlocked = shouldDeferSubmissionUntilHistoryReady(
		session.sessionPath,
		effectiveLoadState,
	);
	const persistDeferredHistorySubmissions = useCallback(
		(submissions: string[]) => {
			if (uiStateKey && writeUiState) {
				writeUiState(uiStateKey, { deferredSubmissions: submissions });
			}
		},
		[uiStateKey, writeUiState],
	);
	const handleComposerSubmit = useCallback(
		(submission: ChatSubmission) => {
			if (!historySubmissionBlocked) {
				handleSubmit(submission);
				setComposerImages([]);
				return;
			}
			if (submission.images.length > 0) {
				toast.info("历史消息加载完成后再发送图片");
				return;
			}
			const trimmed = submission.text.trim();
			if (!trimmed) return;
			const next = [...pendingHistorySubmissionsRef.current, trimmed];
			pendingHistorySubmissionsRef.current = next;
			persistDeferredHistorySubmissions(next);
			clearDraft();
		},
		[
			clearDraft,
			handleSubmit,
			historySubmissionBlocked,
			persistDeferredHistorySubmissions,
		],
	);
	useEffect(() => {
		if (historySubmissionBlocked || running) return;
		const [first, ...rest] = pendingHistorySubmissionsRef.current;
		if (!first) return;
		pendingHistorySubmissionsRef.current = [];
		persistDeferredHistorySubmissions([]);
		handleSubmit(createChatSubmission(first));
		for (const message of rest) handleFollowUp(createChatSubmission(message));
	}, [
		handleFollowUp,
		handleSubmit,
		historySubmissionBlocked,
		persistDeferredHistorySubmissions,
		running,
	]);

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

	// 输入框要显示 Pi 真实使用的模型与推理强度，而不是占位文案；
	// 每个会话在首次激活时读取一次 agent 状态。
	const loadedModelSessionRef = useRef<string | null>(null);
	useEffect(() => {
		if (!active) return;
		if (loadedModelSessionRef.current === session.id) return;
		loadedModelSessionRef.current = session.id;
		void loadModelOptions();
	}, [active, session.id, loadModelOptions]);

	useKeyboardShortcut(
		keyboardShortcuts["cycle-model"],
		() => {
			if (modelOptions.length === 0) {
				void loadModelOptions();
				return;
			}
			const currentIndex = selectedModel
				? modelOptions.findIndex(
						(model) =>
							model.provider === selectedModel.provider &&
							model.id === selectedModel.id,
					)
				: -1;
			const nextModel = modelOptions[(currentIndex + 1) % modelOptions.length];
			if (nextModel) handleModelChange(nextModel);
		},
		{
			enabled:
				active &&
				!modelChanging &&
				modelLoadState !== "loading" &&
				!runtimeBusy &&
				!historyPending,
		},
	);

	useKeyboardShortcut(
		keyboardShortcuts["cycle-scoped-model"],
		handleQuickCycleModel,
		{
			enabled:
				active &&
				!modelChanging &&
				modelLoadState !== "loading" &&
				!runtimeBusy &&
				!historyPending,
		},
	);

	// Keep the session controller subscribed while its view is in the background.
	if (!active) return null;
	const viewportUiState =
		uiStateKey && readUiState ? readUiState(uiStateKey) : initialUiState;

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
				<ChatConversationViewport
					ref={conversationViewportRef}
					active={active}
					sessionId={session.id}
					sessionPath={session.sessionPath}
					messages={messages}
					activeAssistantMessageId={activeAssistantMessageId}
					effectiveLoadState={effectiveLoadState}
					initialScrollTop={viewportUiState.scrollTop}
					initialSticky={viewportUiState.sticky}
					onScrollStateChange={persistScrollState}
					runtimeScrollRef={scrollRef}
					onOpenFile={onOpenFile}
					onRetry={onRetry}
					onRetryHistory={retryHistory}
				/>

				{/* -mt-4 让滚动区底部上探 16px，消息在输入卡背后被自然裁切；
				    裁切线藏在卡片圆角(12px)以内，输入框下方缝隙不会露出消息 */}
				<div
					className="relative -mt-4 w-full shrink-0 pb-4"
					style={{ paddingRight: scrollbarWidth }}
				>
					<ConversationColumn className="relative">
						<ChatPendingQueue items={pendingUsers} />
						<ChatComposer
							value={draft}
							onChange={setDraft}
							images={composerImages}
							onImagesChange={setComposerImages}
							onSubmit={handleComposerSubmit}
							onSteer={
								running
									? (submission) => {
											setComposerImages([]);
											handleSteer(submission);
										}
									: undefined
							}
							onFollowUp={
								running
									? (submission) => {
											setComposerImages([]);
											handleFollowUp(submission);
										}
									: undefined
							}
							disabled={false}
							running={running}
							onStop={handleStop}
							pendingSteering={pendingSteering}
							pendingFollowUps={pendingFollowUps}
							statusText={historyProgress}
							contextUsage={sessionState}
							models={modelOptions}
							selectedModel={selectedModel}
							modelLoading={modelLoadState === "loading"}
							modelError={modelError}
							modelDisabled={modelChanging || runtimeBusy || historyPending}
							onModelMenuOpen={() => void loadModelOptions()}
							onModelRefresh={() => void loadModelOptions(true)}
							onModelChange={handleModelChange}
							thinkingLevels={thinkingLevels}
							selectedThinkingLevel={selectedThinkingLevel}
							thinkingLoading={thinkingLoading}
							thinkingDisabled={
								thinkingChanging ||
								runtimeBusy ||
								historyPending ||
								thinkingLevels.length === 0
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
