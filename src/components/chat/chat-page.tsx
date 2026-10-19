import {
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";
import { ProjectWorkspacePanel } from "@/components/app/project-workspace-panel";
import { useTranslation } from "react-i18next";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { CacheKeepAliveNotice } from "@/components/chat/cache-keep-alive-notice";
import { useCacheKeepAliveStatus } from "@/lib/use-cache-keep-alive-status";
import { useNextPrompt } from "@/components/chat/use-next-prompt";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { promptEnhancementModel } from "@/lib/prompt-enhancement";
import { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
import { SessionMentionScope } from "@/components/chat/session-mention-context";
import { ChatComposer } from "@/components/chat/chat-composer";
import { uploadChatFile } from "@/lib/api/files";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import {
	ChatConversationViewport,
	type ChatConversationViewportHandle,
} from "@/components/chat/chat-conversation-viewport";
import { ChatImageScopeProvider } from "@/components/chat/chat-image-viewer";
import { ChatMarkdownImageScopeProvider } from "@/components/chat/chat-markdown-image";
import { ChatMarkdownLinkScope } from "@/components/chat/chat-markdown-link";
import { ChatPendingQueue } from "@/components/chat/chat-pending-queue";
import { ChatRuntimeRecoveryNotice } from "@/components/chat/chat-runtime-recovery-notice";
import { ChatTodoCapsule } from "@/components/chat/chat-todo-capsule";
import { ChatInterruptedTurnNotice } from "@/components/chat/chat-interrupted-turn-notice";
import { piSessionSuggestions } from "@/components/chat/chat-composer-suggestions";
import { PiExtensionNotifications } from "@/components/chat/pi-extension-notifications";
import { PiExtensionUiDialog } from "@/components/chat/pi-extension-ui-dialog";
import { SessionHeader } from "@/components/chat/chat-session-header";
import { ChatFindLayer } from "@/components/chat/chat-find-bar";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { shouldDeferSubmissionUntilHistoryReady } from "@/components/chat/chat-submission-state";
import { ChatConversationSubscriber } from "@/components/chat/chat-conversation-subscriber";
import { useChatComposerSubmission } from "@/components/chat/use-chat-composer-submission";
import { useChatConversation } from "@/components/chat/use-chat-conversation";
import { useChatFileSuggestions } from "@/components/chat/use-chat-file-suggestions";
import { useChatFork } from "@/components/chat/use-chat-fork";
import { useChatModelShortcuts } from "@/components/chat/use-chat-model-shortcuts";
import { useChatPageUiState } from "@/components/chat/use-chat-page-ui-state";
import { useChatRuntime } from "@/components/chat/use-chat-runtime";
import { useChatSessionConfig } from "@/components/chat/use-chat-session-config";
import { useChatSubmissionRecovery } from "@/components/chat/use-chat-submission-recovery";
import { useChatVisualRetention } from "@/components/chat/use-chat-visual-retention";
import { usePiSessionFeatures } from "@/components/chat/use-pi-session-features";
import { useScrollbarGutterWidth } from "@/components/chat/use-scrollbar-gutter";
import { createChatSessionClient } from "@/lib/api/chat-session-client";
import {
	getActiveStreamingPresentationChars,
	getStreamingPresentationIntervalMs,
} from "@/lib/chat/chat-stream-presentation";
import { type ChatImageAttachment } from "@/lib/chat/chat-submission";
import { createConversationState } from "@/lib/chat/conversation-reducer";

import { usePreferences } from "@/lib/preferences-provider";

export type { ChatSession } from "@/components/chat/chat-page-utils";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

type ChatPageProps = {
	session: ChatSession;
	active?: boolean;
	retainBackgroundVisual?: boolean;
	onSessionIdentified?: (sessionId: string) => void;
	onOpenChanges?: () => void;
	onOpenTerminal?: () => void;
	terminalRunning?: boolean;
	terminalVisible?: boolean;
	onNewChat?: () => void;
	onNewTemporaryChat?: () => void;
	onRenameSession?: (title: string) => void;
	onOpenInNewWindow?: () => void;
	onExpandSidebar?: () => void;
	controllerId?: string;
	performanceSessionId?: string;
	uiStateKey?: string;
	readUiState?: (key: string) => ChatUiState;
	writeUiState?: (key: string, patch: ChatUiStatePatch) => void;
	readProjectDraft?: (projectId: string) => string;
	writeProjectDraft?: (projectId: string, value: string) => void;
	onRuntimeBusyChange?: (controllerId: string, busy: boolean) => void;
	onVisualReadyChange?: (ready: boolean) => void;
	showSwitchSkeleton?: boolean;
	onForkSessionCreated?: (session: {
		sessionId: string;
		sessionPath: string;
	}) => void;
	initialMessage?: string;
	initialImages?: readonly ChatImageAttachment[];
	loadState?: "ready" | "loading" | "error";
	onRetry?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
};

function ChatPageImpl(props: ChatPageProps) {
	const {
		session,
		active = true,
		retainBackgroundVisual = true,
		onSessionIdentified,
		onOpenChanges,
		onOpenTerminal,
		terminalRunning = false,
		terminalVisible = false,
		onNewChat,
		onNewTemporaryChat,
		onRenameSession,
		onOpenInNewWindow,
		onExpandSidebar,
		controllerId,
		performanceSessionId,
		uiStateKey,
		readUiState,
		writeUiState,
		readProjectDraft,
		writeProjectDraft,
		onRuntimeBusyChange,
		onVisualReadyChange,
		showSwitchSkeleton = false,
		onForkSessionCreated,
		initialMessage,
		initialImages = EMPTY_CHAT_IMAGES,
		loadState = "ready",
		onRetry,
		reserveWindowControls = false,
		sidebarCollapsed = false,
	} = props;
	const { t } = useTranslation();
	const { desktopNotifications, keyboardShortcuts } = usePreferences();
	const workspace = useContext(ProjectWorkspaceContext);
	const fileActive = Boolean(
		workspace?.state.get(session.projectRecord.id)?.activePath,
	);
	const {
		initialUiState,
		initialDeferredSubmissions,
		persistDraft,
		persistScrollState,
		persistVirtualizerCache,
	} = useChatPageUiState({
		uiStateKey,
		readUiState,
		writeUiState,
		sessionPath: session.sessionPath,
		projectId: session.projectRecord.id,
		writeProjectDraft,
		active,
	});
	const activeTurnSessionIdRef = useRef<string | null>(null);
	const projectMcpApprovalPendingRef = useRef(false);
	const client = useMemo(
		() =>
			createChatSessionClient(session.projectRecord.id, session.id, undefined, {
				noSession: session.temporary,
				owner: "chat_controller",
			}),
		[session.projectRecord.id, session.id, session.temporary],
	);
	useEffect(() => {
		client.updateSessionPath(session.sessionPath);
	}, [client, session.sessionPath]);
	const sessionConfig = useChatSessionConfig({
		session,
		client,
	});
	const {
		sessionState,
		sessionHeaderMissing,
		commands,
		modelScope,
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
		loadModelOptions,
		handleModelChange,
		handleQuickCycleModel,
		loadThinkingLevels,
		handleThinkingChange,
		prepareRuntimeConfiguration,
		refreshSessionState,
		refreshSessionStats,
	} = sessionConfig;
	// 草稿优化按当前项目所属 Connection 的 Host 设置开关；默认关闭。
	const promptEnhancement = usePromptEnhancementSettings(
		tauriPiloClient,
		session.projectRecord.connection.id,
	);
	const readOnly = Boolean(session.externalRunning || sessionHeaderMissing);
	const conversation = useChatConversation({
		session,
		activeTurnSessionIdRef,
		initialMessage,
		initialImages,
		initialDraft: readProjectDraft
			? readProjectDraft(session.projectRecord.id)
			: initialUiState.draft,
		onDraftChange: persistDraft,
		onHistoryMetadata: applyHistoryMetadata,
	});
	const {
		conversationStore,
		historyStore,
		baseMessages,
		draft,
		setDraft,
		clearDraft,
		dispatchConversationBatch,
		getConversationMessages,
		requestHistoryRange,
		historyLoadState,
		historyError,
		historyIndexStale,
		historyImageFingerprint,
		historyPending,
		retryHistory,
		refreshHistoryIfStale,
	} = conversation;
	const getActivePresentationIntervalMs = useCallback(
		() =>
			getStreamingPresentationIntervalMs(
				getActiveStreamingPresentationChars(conversationStore.getSnapshot()),
			),
		[conversationStore],
	);
	const scrollRef = useRef<HTMLDivElement>(null);
	const conversationViewportRef = useRef<ChatConversationViewportHandle>(null);
	const [findOpen, setFindOpen] = useState(false);
	const handleFindNavigate = useCallback((messageIndex: number) => {
		conversationViewportRef.current?.scrollToMessageIndex(messageIndex);
	}, []);
	// 历史消息图片按 session snapshot 懒加载；本地消息由独立 Blob URL 缓存提供。
	const historyImageScope = useMemo(
		() =>
			session.sessionPath
				? {
						projectId: session.projectRecord.id,
						sessionPath: session.sessionPath,
						fingerprint: historyImageFingerprint,
					}
				: null,
		[historyImageFingerprint, session.projectRecord.id, session.sessionPath],
	);
	const projectImageScope = useMemo(
		() => ({ projectId: session.projectRecord.id, sessionKey: session.id }),
		[session.projectRecord.id, session.id],
	);
	const scrollToBottom = useCallback((smooth = true) => {
		conversationViewportRef.current?.scrollToBottom(smooth);
	}, []);
	const scrollbarWidth = useScrollbarGutterWidth(scrollRef, active);
	const {
		composerImages,
		setComposerImages,
		restoreSubmission,
		recoverSubmission,
	} = useChatSubmissionRecovery({
		draft,
		setDraft,
		active,
		projectId: session.projectRecord.id,
		readProjectDraft,
	});
	const resetConversation = useCallback(() => {
		conversationStore.setSnapshot(createConversationState([]));
	}, [conversationStore]);
	const runtime = useChatRuntime({
		active,
		session,
		// 通知标题与页头一致：优先使用 Pi 当前会话名（自动命名后立即更新），
		// 会话索引里的 session.title 可能滞后到下一次 watcher 刷新。
		sessionTitle: sessionState?.name || session.title,
		client,
		activeTurnSessionIdRef,
		projectMcpApprovalPendingRef,
		initialMessage,
		initialImages,
		initialQueuedMessages: initialDeferredSubmissions.runtime,
		desktopNotifications,
		onSessionIdentified,
		dispatchConversationBatch,
		resetConversation,
		getActivePresentationIntervalMs,
		scrollRef,
		scrollToBottom,
		clearDraft,
		restoreSubmission,
		recoverSubmission,
		prepareRuntimeConfiguration,
		refreshSessionState,
		refreshSessionStats,
	});
	const {
		activeTurnSessionId,
		pendingFollowUps,
		running,
		runtimeBusy,
		recoveryState,
		clearRecoveryState,
		resumeProjectMcpTurn,
		failProjectMcpTurn,
		cancelProjectMcpTurn,
		handleSubmit,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleSendNow,
		handleStop,
	} = runtime;
	useEffect(() => {
		if (!active || session.sessionPath || recoveryState.status === "failed") {
			return;
		}
		void client.prepare().catch((error) => {
			console.warn("Failed to prewarm active Pi session", error);
		});
	}, [active, client, recoveryState.status, session.sessionPath]);

	const { renderVisual, handleVisualReady } = useChatVisualRetention({
		active,
		retainBackgroundVisual,
		runtimeBusy,
		uiStateKey,
		writeUiState,
		onVisualReadyChange,
	});
	const piFeatures = usePiSessionFeatures({
		client,
		commands,
		active,
		readOnly,
		projectMcpApprovalPendingRef,
		onSetEditorText: setDraft,
		onRefreshSessionState: refreshSessionState,
		onProjectMcpApprovalRequested: clearRecoveryState,
		onProjectMcpApproved: resumeProjectMcpTurn,
		onProjectMcpApprovalFailed: failProjectMcpTurn,
		onProjectMcpDeclined: cancelProjectMcpTurn,
	});
	const {
		commandSuggestions,
		tryExecuteExtensionCommand,
		compact,
		compacting,
		retryState,
		abortRetry,
		extensionDialog,
		respondToExtensionDialog,
		statusText: piStatusText,
		extensionNotifications,
		dismissExtensionNotification,
	} = piFeatures;
	const cacheKeepAlive = useCacheKeepAliveStatus({
		client: tauriPiloClient,
		sessionKey: client.sessionKey,
		active,
		subscribe: true,
	});
	const nextPrompt = useNextPrompt({
		client: tauriPiloClient,
		connectionId: session.projectRecord.connection.id,
		sessionKey: client.sessionKey,
		sessionId: sessionState?.sessionId ?? null,
		draft,
		hasAttachments: composerImages.length > 0,
		active,
		loading: historyPending,
		busy: runtimeBusy || compacting || Boolean(retryState),
		blocked:
			Boolean(readOnly || extensionDialog) ||
			modelChanging ||
			recoveryState.status === "failed" ||
			recoveryState.status === "reconnecting",
		model: selectedModel,
		getSessionState: client.getPiAgentState,
		subscribe: true,
	});
	const { fileSuggestions, handleSuggestionTrigger } = useChatFileSuggestions({
		projectId: session.projectRecord.id,
	});
	const composerSuggestions = useMemo(
		() => [
			...fileSuggestions,
			...piSessionSuggestions(t),
			...commandSuggestions,
		],
		[commandSuggestions, fileSuggestions, t],
	);

	const controllerMessageCount =
		conversationStore.getSnapshot()?.messages.length ?? baseMessages.length;
	const controllerEffectiveLoadState = session.sessionPath
		? historyLoadState === "loading" && controllerMessageCount > 0
			? "ready"
			: historyLoadState
		: loadState;
	const historySubmissionBlocked = shouldDeferSubmissionUntilHistoryReady(
		session.sessionPath,
		controllerEffectiveLoadState,
	);

	const { handleComposerSubmit, tryHandleComposerCommand } =
		useChatComposerSubmission({
			uiStateKey,
			writeUiState,
			initialDeferredHistory: initialDeferredSubmissions.history,
			externalRunning: readOnly,
			historySubmissionBlocked,
			running,
			clearDraft,
			clearImages: () => setComposerImages([]),
			onNewChat,
			compact,
			tryExecuteExtensionCommand,
			handleSubmit,
			handleFollowUp,
		});

	const { forkingMessageId, handleForkAssistant } = useChatFork({
		client,
		session,
		runtimeBusy: runtimeBusy || readOnly,
		historyPending,
		getConversationMessages,
		onForkSessionCreated,
	});

	useEffect(() => {
		if (controllerId) onRuntimeBusyChange?.(controllerId, runtimeBusy);
	}, [controllerId, onRuntimeBusyChange, runtimeBusy]);

	useEffect(
		() => () => {
			if (controllerId) onRuntimeBusyChange?.(controllerId, false);
		},
		[controllerId, onRuntimeBusyChange],
	);

	useEffect(() => {
		refreshHistoryIfStale(active, activeTurnSessionId);
	}, [active, activeTurnSessionId, refreshHistoryIfStale]);

	useChatModelShortcuts({
		active,
		cycleModelShortcut: keyboardShortcuts["cycle-model"],
		cycleScopedModelShortcut: keyboardShortcuts["cycle-scoped-model"],
		modelOptions,
		selectedModel,
		modelChanging,
		modelLoadState,
		runtimeBusy: runtimeBusy || readOnly,
		historyPending,
		loadModelOptions,
		handleModelChange,
		handleQuickCycleModel,
	});

	// Preserve the last painted visual tree for a busy/recent background chat so
	// switching back can reveal existing DOM immediately. The subscriber below is
	// frozen while inactive, so background Pi output still drives zero Markdown or
	// Virtua work. Idle snapshots expire to keep hidden DOM memory bounded.
	if (!renderVisual) return null;

	return (
		<SessionMentionScope connectionId={session.projectRecord.connection.id}>
			<ChatConversationSubscriber
				active={active}
				conversationStore={conversationStore}
				historyStore={historyStore}
				baseMessages={baseMessages}
				sessionPath={session.sessionPath}
				historyLoadState={historyLoadState}
				loadState={loadState}
			>
				{(
					{
						messages,
						pendingUsers,
						latestTurnInterrupted,
						activeAssistantMessageId,
						effectiveLoadState,
					},
					live,
				) => {
					const viewportUiState =
						uiStateKey && readUiState
							? readUiState(uiStateKey)
							: initialUiState;
					const emptyTemporarySession =
						Boolean(session.temporary) &&
						effectiveLoadState === "ready" &&
						messages.length === 0;
					return (
						// @container：面板宽度查询容器。大纲栏与本列 padding 以面板为基准，
						// ConversationColumn 内部的断点以消息列自身宽度为基准（嵌套容器）。
						<div className="@container flex h-full min-w-0 flex-col bg-background">
							<SessionHeader
								session={session}
								sessionState={sessionState ?? undefined}
								onOpenChanges={onOpenChanges}
								onOpenTerminal={onOpenTerminal}
								terminalRunning={terminalRunning}
								terminalVisible={terminalVisible}
								onNewTemporaryChat={onNewTemporaryChat}
								onRenameSession={onRenameSession}
								onFindInSession={() => setFindOpen(true)}
								onOpenInNewWindow={onOpenInNewWindow}
								onExpandSidebar={onExpandSidebar}
								reserveWindowControls={reserveWindowControls}
								sidebarCollapsed={sidebarCollapsed}
								overlay={emptyTemporarySession}
							/>
							<ProjectWorkspacePanel
								project={session.projectRecord}
								active={active}
								headerOverlay={emptyTemporarySession}
							>
								<ChatFindLayer
									active={active && !fileActive}
									open={findOpen}
									onOpen={() => setFindOpen(true)}
									onClose={() => setFindOpen(false)}
									messages={messages}
									onNavigate={handleFindNavigate}
								>
									<ChatMarkdownLinkScope.Provider value={session.projectRecord}>
										<ChatMarkdownImageScopeProvider scope={projectImageScope}>
											<ChatImageScopeProvider scope={historyImageScope}>
												<ChatConversationViewport
													ref={conversationViewportRef}
													active={active}
													visualLive={live}
													showSwitchSkeleton={showSwitchSkeleton}
													sessionId={performanceSessionId ?? session.id}
													sessionPath={session.sessionPath}
													messages={messages}
													onVisibleRangeChange={requestHistoryRange}
													activeAssistantMessageId={activeAssistantMessageId}
													compacting={compacting}
													effectiveLoadState={effectiveLoadState}
													initialScrollTop={viewportUiState.scrollTop}
													initialSticky={viewportUiState.sticky}
													initialVirtualizerCache={
														viewportUiState.virtualizerMessageCount ===
														messages.length
															? viewportUiState.virtualizerCache
															: undefined
													}
													onScrollStateChange={persistScrollState}
													onVirtualizerCacheChange={persistVirtualizerCache}
													runtimeScrollRef={scrollRef}
													onForkAssistant={
														!session.temporary ? handleForkAssistant : undefined
													}
													forkingMessageId={forkingMessageId}
													forkDisabled={
														readOnly ||
														runtimeBusy ||
														historyPending ||
														Boolean(forkingMessageId)
													}
													suppressInterruptedError={
														session.externalTurnOpen || running
													}
													onVisualReady={handleVisualReady}
													onRetry={onRetry}
													onRetryHistory={retryHistory}
												/>
											</ChatImageScopeProvider>
										</ChatMarkdownImageScopeProvider>
									</ChatMarkdownLinkScope.Provider>
								</ChatFindLayer>

								{/* -mt-4 让滚动区底部上探 16px，消息在输入卡背后被自然裁切；
							    裁切线藏在卡片圆角(12px)以内，输入框下方缝隙不会露出消息 */}
								{/* 滚动区 scrollbar-gutter 恒为 stable（.chat-scrollbar），paddingRight
							    恒补偿 gutter 宽度，空会话 → 首条消息不再横跳 */}
								<div
									data-chat-composer-region=""
									className="relative z-20 -mt-4 w-full shrink-0 pb-4"
									style={{ paddingRight: scrollbarWidth }}
								>
									<ConversationColumn className="relative">
										<ChatPendingQueue
											items={pendingUsers}
											onEdit={(item) =>
												void handleEditQueued(item.clientMessageId)
											}
											onSendNow={(item) =>
												void handleSendQueuedNow(item.clientMessageId)
											}
										/>
										{recoveryState.status === "idle" &&
										!session.externalTurnOpen &&
										!running &&
										latestTurnInterrupted ? (
											<ChatInterruptedTurnNotice />
										) : null}
										<ChatRuntimeRecoveryNotice
											state={recoveryState}
											onNewTemporaryChat={
												session.temporary ? onNewTemporaryChat : undefined
											}
										/>
										<PiExtensionNotifications
											notifications={extensionNotifications}
											onDismiss={dismissExtensionNotification}
										/>
										{extensionDialog ? (
											<PiExtensionUiDialog
												request={extensionDialog}
												onRespond={(response) =>
													void respondToExtensionDialog(response)
												}
											/>
										) : null}
										<CacheKeepAliveNotice
											key={`cache-keep-alive:${client.sessionKey}`}
											status={cacheKeepAlive.status}
										/>
										<ChatTodoCapsule
											key={`chat-todo:${client.sessionKey}`}
											conversationStore={conversationStore}
											historyMessages={baseMessages}
											running={running}
										/>
										<ChatComposer
											nextPrompt={nextPrompt.text}
											onNextPromptDismiss={nextPrompt.dismiss}
											value={readOnly ? "" : draft}
											historyKey={session.projectRecord.id}
											attachmentScopeKey={`${session.projectRecord.id}:${session.id}`}
											onUploadFile={(file) =>
												uploadChatFile(session.projectRecord.id, file)
											}
											onEnhancePrompt={
												promptEnhancement.settings?.enabled
													? (draftValue) =>
															tauriPiloClient.enhancePrompt(
																session.projectRecord.id,
																draftValue,
																promptEnhancementModel(selectedModel),
															)
													: undefined
											}
											placeholder={
												readOnly
													? sessionHeaderMissing
														? t("chat.sessionHeaderMissing")
														: t("chat.externalReadOnly")
													: undefined
											}
											onChange={setDraft}
											images={composerImages}
											onImagesChange={setComposerImages}
											onSubmit={handleComposerSubmit}
											onSteer={
												running
													? (submission) => {
															void (async () => {
																if (await tryHandleComposerCommand(submission))
																	return;
																setComposerImages([]);
																handleSteer(submission);
															})();
														}
													: undefined
											}
											onSendNow={
												running
													? async (submission) => {
															if (await tryHandleComposerCommand(submission))
																return;
															setComposerImages([]);
															await handleSendNow(submission);
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
											disabled={
												// 后台保留页不可见；其 focus-composer hook 先注册、先执行，
												// 会 preventDefault 后 focus 隐藏 textarea（no-op），吞掉新会话页的 Ctrl+L。
												!active ||
												recoveryState.status === "reconnecting" ||
												readOnly
											}
											muted={readOnly}
											running={running}
											onStop={handleStop}
											pendingFollowUps={pendingFollowUps}
											statusText={readOnly ? "" : piStatusText}
											statusError={
												(sessionHeaderMissing
													? t("chat.sessionHeaderMissing")
													: null) ??
												(readOnly ? null : retryState?.errorMessage) ??
												historyError ??
												(historyIndexStale &&
												!running &&
												!session.externalTurnOpen
													? t("chat.historyIndexStale")
													: null)
											}
											compacting={compacting}
											retrying={retryState?.kind === "agent"}
											onAbortRetry={() => void abortRetry()}
											contextUsage={sessionState}
											suggestions={composerSuggestions}
											onSuggestionTrigger={handleSuggestionTrigger}
											models={modelOptions}
											modelScope={modelScope}
											selectedModel={selectedModel}
											modelLoading={modelLoadState === "loading"}
											modelError={modelError}
											modelDisabled={
												modelChanging ||
												runtimeBusy ||
												historyPending ||
												readOnly
											}
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
												readOnly ||
												thinkingLevels.length === 0
											}
											onThinkingMenuOpen={() => void loadThinkingLevels()}
											onThinkingChange={handleThinkingChange}
										/>
									</ConversationColumn>
								</div>
							</ProjectWorkspacePanel>
						</div>
					);
				}}
			</ChatConversationSubscriber>
		</SessionMentionScope>
	);
}

function chatPagePropsEqual(previous: ChatPageProps, next: ChatPageProps) {
	const previousActive = previous.active ?? true;
	const nextActive = next.active ?? true;

	// Keep inactive conversations mounted so their controller/local state survives,
	// but do not let unrelated App updates execute the entire ChatPage function.
	// React compares again when active changes, so reopening uses the latest props.
	if (!previousActive && !nextActive) {
		return (
			(previous.retainBackgroundVisual ?? true) ===
			(next.retainBackgroundVisual ?? true)
		);
	}

	return false;
}

export const ChatPage = memo(ChatPageImpl, chatPagePropsEqual);
