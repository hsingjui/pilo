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
import { PI_SESSION_SUGGESTIONS } from "@/components/chat/chat-composer-suggestions";
import { PiExtensionNotifications } from "@/components/chat/pi-extension-notifications";
import { PiExtensionUiDialog } from "@/components/chat/pi-extension-ui-dialog";
import { SessionHeader } from "@/components/chat/chat-session-header";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import {
	routeInitialDeferredSubmissions,
	shouldDeferSubmissionUntilHistoryReady,
} from "@/components/chat/chat-submission-state";
import { useChatConversation } from "@/components/chat/use-chat-conversation";
import { useChatRuntime } from "@/components/chat/use-chat-runtime";
import { useChatSessionConfig } from "@/components/chat/use-chat-session-config";
import { usePiSessionFeatures } from "@/components/chat/use-pi-session-features";
import { userErrorMessage } from "@/lib/app-error";
import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	createChatSubmission,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { resolveAssistantForkTarget } from "@/lib/pi-session-fork";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { toast } from "sonner";

function keyedWidgetLines(lines: readonly string[]) {
	const counts = new Map<string, number>();
	return lines.map((line) => {
		const count = counts.get(line) ?? 0;
		counts.set(line, count + 1);
		return { key: `${line}:${count}`, line };
	});
}

export type { ChatSession } from "@/components/chat/chat-page-utils";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

type ChatPageProps = {
	session: ChatSession;
	active?: boolean;
	onSessionIdentified?: (sessionId: string) => void;
	onOpenChanges?: () => void;
	onOpenTerminal?: () => void;
	terminalRunning?: boolean;
	terminalVisible?: boolean;
	onNewTemporaryChat?: () => void;
	onExpandSidebar?: () => void;
	onSessionChanged?: () => void;
	controllerId?: string;
	uiStateKey?: string;
	readUiState?: (key: string) => ChatUiState;
	writeUiState?: (key: string, patch: ChatUiStatePatch) => void;
	onRuntimeBusyChange?: (controllerId: string, busy: boolean) => void;
	onOpenFile?: (path: string) => void;
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

function ChatPageImpl({
	session,
	active = true,
	onSessionIdentified,
	onOpenChanges,
	onOpenTerminal,
	terminalRunning = false,
	terminalVisible = false,
	onNewTemporaryChat,
	onExpandSidebar,
	onSessionChanged,
	controllerId,
	uiStateKey,
	readUiState,
	writeUiState,
	onRuntimeBusyChange,
	onOpenFile,
	onForkSessionCreated,
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
				{ noSession: session.temporary },
			),
		[
			session.projectRecord.id,
			session.id,
			session.sessionPath,
			session.temporary,
		],
	);
	useEffect(() => {
		if (!active || session.sessionPath) return;
		void client.prepare().catch((error) => {
			console.warn("Failed to prewarm active Pi session", error);
		});
	}, [active, client, session.sessionPath]);

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
	const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
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
	const draftRef = useRef(draft);
	const composerImagesRef = useRef(composerImages);
	useLayoutEffect(() => {
		draftRef.current = draft;
	}, [draft]);
	useLayoutEffect(() => {
		composerImagesRef.current = composerImages;
	}, [composerImages]);
	const restoreSubmission = useCallback(
		(submission: ChatSubmission) => {
			draftRef.current = submission.text;
			composerImagesRef.current = [...submission.images];
			setDraft(submission.text);
			setComposerImages([...submission.images]);
		},
		[setDraft],
	);
	const recoverSubmission = useCallback(
		(submission: ChatSubmission) => {
			const currentText = draftRef.current.trim();
			const nextText = [currentText, submission.text]
				.filter(Boolean)
				.join("\n\n");
			const seenImageIds = new Set<string>();
			const nextImages = [
				...composerImagesRef.current,
				...submission.images,
			].filter((image) => {
				if (seenImageIds.has(image.id)) return false;
				seenImageIds.add(image.id);
				return true;
			});
			draftRef.current = nextText;
			composerImagesRef.current = nextImages;
			setDraft(nextText);
			setComposerImages(nextImages);
		},
		[setDraft],
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
		handleEditQueued,
		handleSendQueuedNow,
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
		restoreSubmission,
		recoverSubmission,
		prepareRuntimeConfiguration,
		refreshSessionState,
	});
	const {
		commandSuggestions,
		loadCommands,
		compact,
		retryState,
		abortRetry,
		extensionDialog,
		respondToExtensionDialog,
		statusText: piStatusText,
		widgets: extensionWidgets,
		extensionNotifications,
		dismissExtensionNotification,
	} = usePiSessionFeatures({
		client,
		active,
		onSetEditorText: setDraft,
		onRefreshSessionState: refreshSessionState,
	});
	const composerSuggestions = useMemo(
		() => [...PI_SESSION_SUGGESTIONS, ...commandSuggestions],
		[commandSuggestions],
	);

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
			const command = submission.text.trim();
			if (command === "/compact" || command.startsWith("/compact ")) {
				if (running) {
					toast.info("当前回复完成后再压缩上下文");
					return;
				}
				const customInstructions = command.slice("/compact".length).trim();
				clearDraft();
				setComposerImages([]);
				void compact(customInstructions || undefined);
				return;
			}
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
			compact,
			handleSubmit,
			historySubmissionBlocked,
			persistDeferredHistorySubmissions,
			running,
		],
	);

	const handleForkAssistant = useCallback(
		async (messageId: string) => {
			if (
				forkingMessageId ||
				runtimeBusy ||
				historyPending ||
				session.temporary
			) {
				return;
			}

			setForkingMessageId(messageId);
			let forkClient: ReturnType<typeof createChatSessionClient> | null = null;
			let forkedSession: { sessionId: string; sessionPath: string } | null =
				null;
			try {
				await client.ensure();
				const [sourceState, entries] = await Promise.all([
					client.getPiAgentState(),
					client.getPiEntries(),
				]);
				if (!sourceState.sessionFile) {
					throw new Error("当前会话尚未保存，暂时无法 Fork。");
				}
				const target = resolveAssistantForkTarget(messages, messageId, entries);
				const forkRuntimeId = `fork-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				forkClient = createChatSessionClient(
					session.projectRecord.id,
					forkRuntimeId,
					sourceState.sessionFile,
				);
				await forkClient.ensure();
				const result =
					target.type === "clone"
						? await forkClient.clonePiSession()
						: await forkClient.forkPiSession(target.entryId);
				if (result.cancelled) {
					toast.info("Fork 已取消");
					return;
				}

				const state = await forkClient.getPiAgentState();
				if (!state.sessionId || !state.sessionFile) {
					throw new Error("Pi 未返回 Fork 后的新会话信息。");
				}
				forkedSession = {
					sessionId: state.sessionId,
					sessionPath: state.sessionFile,
				};
			} catch (error) {
				toast.error("Fork 新对话失败", {
					description: userErrorMessage(error),
				});
			} finally {
				await forkClient?.stop().catch(() => undefined);
				setForkingMessageId(null);
			}
			if (forkedSession) onForkSessionCreated?.(forkedSession);
		},
		[
			client,
			forkingMessageId,
			historyPending,
			messages,
			onForkSessionCreated,
			runtimeBusy,
			session.projectRecord.id,
			session.temporary,
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
	const emptyTemporarySession =
		Boolean(session.temporary) &&
		effectiveLoadState === "ready" &&
		messages.length === 0;

	return (
		<div className="flex h-full min-w-0 flex-col bg-background">
			<SessionHeader
				session={session}
				sessionState={sessionState ?? undefined}
				onRename={session.temporary ? undefined : handleRenameSession}
				onOpenChanges={onOpenChanges}
				onOpenTerminal={onOpenTerminal}
				terminalRunning={terminalRunning}
				terminalVisible={terminalVisible}
				onNewTemporaryChat={onNewTemporaryChat}
				onExpandSidebar={onExpandSidebar}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
				overlay={emptyTemporarySession}
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
					onForkAssistant={!session.temporary ? handleForkAssistant : undefined}
					forkingMessageId={forkingMessageId}
					forkDisabled={
						runtimeBusy || historyPending || Boolean(forkingMessageId)
					}
					onRetry={onRetry}
					onRetryHistory={retryHistory}
				/>

				{/* -mt-4 让滚动区底部上探 16px，消息在输入卡背后被自然裁切；
				    裁切线藏在卡片圆角(12px)以内，输入框下方缝隙不会露出消息 */}
				<div
					className="relative -mt-4 w-full shrink-0 pb-4"
					style={{
						paddingRight:
							effectiveLoadState === "ready" && messages.length === 0
								? 0
								: scrollbarWidth,
					}}
				>
					<ConversationColumn className="relative">
						{extensionWidgets
							.filter((widget) => widget.placement === "aboveEditor")
							.map((widget) => (
								<div
									key={widget.key}
									className="mb-2 rounded-lg border border-border/70 bg-muted/35 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground"
								>
									{keyedWidgetLines(widget.lines).map(({ key, line }) => (
										<div key={`${widget.key}:${key}`}>{line}</div>
									))}
								</div>
							))}
						<ChatPendingQueue
							items={pendingUsers}
							onEdit={(item) => void handleEditQueued(item.clientMessageId)}
							onSendNow={(item) =>
								void handleSendQueuedNow(item.clientMessageId)
							}
						/>
						<PiExtensionNotifications
							notifications={extensionNotifications}
							onDismiss={dismissExtensionNotification}
						/>
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
							statusText={[historyProgress, piStatusText]
								.filter(Boolean)
								.join(" · ")}
							retrying={retryState?.kind === "agent"}
							onAbortRetry={() => void abortRetry()}
							contextUsage={sessionState}
							suggestions={composerSuggestions}
							onSuggestionTrigger={(trigger) => {
								if (trigger === "/") void loadCommands();
							}}
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
						{extensionWidgets
							.filter((widget) => widget.placement === "belowEditor")
							.map((widget) => (
								<div
									key={widget.key}
									className="mt-2 rounded-lg border border-border/70 bg-muted/35 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground"
								>
									{keyedWidgetLines(widget.lines).map(({ key, line }) => (
										<div key={`${widget.key}:${key}`}>{line}</div>
									))}
								</div>
							))}
					</ConversationColumn>
				</div>
			</div>
			<PiExtensionUiDialog
				request={extensionDialog}
				onRespond={(response) => void respondToExtensionDialog(response)}
			/>
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
