import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import {
	ChatComposer,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import {
	ChatConversationViewport,
	type ChatConversationViewportHandle,
} from "@/components/chat/chat-conversation-viewport";
import { ChatImageScopeProvider } from "@/components/chat/chat-image-viewer";
import { ChatPendingQueue } from "@/components/chat/chat-pending-queue";
import { ChatRuntimeRecoveryNotice } from "@/components/chat/chat-runtime-recovery-notice";
import { ChatInterruptedTurnNotice } from "@/components/chat/chat-interrupted-turn-notice";
import { PI_SESSION_SUGGESTIONS } from "@/components/chat/chat-composer-suggestions";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import { PiExtensionNotifications } from "@/components/chat/pi-extension-notifications";
import { PiExtensionUiDialog } from "@/components/chat/pi-extension-ui-dialog";
import { SessionHeader } from "@/components/chat/chat-session-header";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import {
	routeInitialDeferredSubmissions,
	shouldDeferSubmissionUntilHistoryReady,
} from "@/components/chat/chat-submission-state";
import {
	useChatConversation,
	useChatConversationView,
} from "@/components/chat/use-chat-conversation";
import { useChatRuntime } from "@/components/chat/use-chat-runtime";
import { useChatSessionConfig } from "@/components/chat/use-chat-session-config";
import { usePiSessionFeatures } from "@/components/chat/use-pi-session-features";
import { useScrollbarGutterWidth } from "@/components/chat/use-scrollbar-gutter";
import { userErrorMessage } from "@/lib/app-error";
import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	getActiveStreamingPresentationChars,
	getStreamingPresentationIntervalMs,
} from "@/lib/chat-stream-presentation";
import {
	createChatSubmission,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { searchProjectFiles } from "@/lib/files";
import { resolveAssistantForkTarget } from "@/lib/pi-session-fork";
import type { CacheSnapshot } from "virtua";
import type { ChatConversationStore } from "@/components/chat/chat-conversation-store";
import type { ChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";
import { createConversationState } from "@/lib/conversation-reducer";
import type { ChatMessage } from "@/lib/conversation-types";

import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { toast } from "sonner";

export type { ChatSession } from "@/components/chat/chat-page-utils";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];
const FILE_SUGGESTION_DEBOUNCE_MS = 180;
const FILE_SUGGESTION_CACHE_TTL_MS = 10_000;
const FILE_SUGGESTION_CACHE_MAX_ENTRIES = 24;
const BACKGROUND_VISUAL_RETENTION_MS = 60_000;

type FileSuggestionCacheEntry = {
	expiresAt: number;
	suggestions: ComposerSuggestion[];
};

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
	onExpandSidebar?: () => void;
	controllerId?: string;
	performanceSessionId?: string;
	uiStateKey?: string;
	readUiState?: (key: string) => ChatUiState;
	writeUiState?: (key: string, patch: ChatUiStatePatch) => void;
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

type ChatConversationSubscriberProps = {
	active: boolean;
	conversationStore: ChatConversationStore;
	historyStore: ChatHistoryWindowStore;
	baseMessages: ChatMessage[];
	sessionPath?: string;
	historyLoadState: "ready" | "loading" | "error";
	loadState: "ready" | "loading" | "error";
	children: (
		view: ReturnType<typeof useChatConversationView>,
		live: boolean,
	) => ReactNode;
};

const ChatConversationSubscriber = memo(
	function ChatConversationSubscriber({
		active,
		conversationStore,
		historyStore,
		baseMessages,
		sessionPath,
		historyLoadState,
		loadState,
		children,
	}: ChatConversationSubscriberProps) {
		// Keep the last visual snapshot mounted while this controller is hidden, but
		// disconnect it from background store updates. On reactivation we first paint
		// the frozen DOM, then reconnect on the next frame so session switching is an
		// urgent, bounded operation rather than a full hidden-output catch-up render.
		const [live, setLive] = useState(active);
		useEffect(() => {
			if (active === live) return;
			const frame = requestAnimationFrame(() => setLive(active));
			return () => cancelAnimationFrame(frame);
		}, [active, live]);
		const view = useChatConversationView({
			conversationStore,
			historyStore,
			baseMessages,
			sessionPath,
			historyLoadState,
			loadState,
			live,
		});
		return children(view, live);
	},
	(previous, next) => !previous.active && !next.active,
);

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
		onExpandSidebar,
		controllerId,
		performanceSessionId,
		uiStateKey,
		readUiState,
		writeUiState,
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
			if (!active || !uiStateKey || !writeUiState) return;
			writeUiState(uiStateKey, state);
		},
		[active, uiStateKey, writeUiState],
	);
	const persistVirtualizerCache = useCallback(
		(cache: CacheSnapshot, messageCount: number) => {
			if (!active || !uiStateKey || !writeUiState) return;
			writeUiState(uiStateKey, {
				virtualizerCache: cache,
				virtualizerMessageCount: messageCount,
			});
		},
		[active, uiStateKey, writeUiState],
	);
	const activeTurnSessionIdRef = useRef<string | null>(null);
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
	useEffect(() => {
		if (!active || session.sessionPath) return;
		void client.prepare().catch((error) => {
			console.warn("Failed to prewarm active Pi session", error);
		});
	}, [active, client, session.sessionPath]);

	const sessionConfig = useChatSessionConfig({
		session,
		client,
	});
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
		loadModelOptions,
		handleModelChange,
		handleQuickCycleModel,
		loadThinkingLevels,
		handleThinkingChange,
		prepareRuntimeConfiguration,
		refreshSessionState,
		refreshSessionStats,
	} = sessionConfig;
	const conversation = useChatConversation({
		session,
		activeTurnSessionIdRef,
		initialMessage,
		initialImages,
		initialDraft: initialUiState.draft,
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
		historyProgress,
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
	const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
	const conversationViewportRef = useRef<ChatConversationViewportHandle>(null);
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
	const scrollToBottom = useCallback((smooth = true) => {
		conversationViewportRef.current?.scrollToBottom(smooth);
	}, []);
	const scrollbarWidth = useScrollbarGutterWidth(scrollRef, active);
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
	const resetConversation = useCallback(() => {
		conversationStore.setSnapshot(createConversationState([]));
	}, [conversationStore]);
	const runtime = useChatRuntime({
		active,
		session,
		client,
		activeTurnSessionIdRef,
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
		pendingSteering,
		pendingFollowUps,
		running,
		runtimeBusy,
		recoveryState,
		handleReconnect,
		handleSubmit,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleStop,
	} = runtime;
	useEffect(() => {
		if (active || !runtimeBusy || !uiStateKey || !writeUiState) return;
		// A frozen background transcript deliberately stops consuming store
		// updates. The assistant can therefore grow without changing message count,
		// making a previously persisted Virtua height cache stale even though the
		// old count still matches. Drop only the measurement cache when background
		// work starts; draft/scroll ownership remain available for the next reveal.
		writeUiState(uiStateKey, {
			virtualizerCache: undefined,
			virtualizerMessageCount: undefined,
		});
	}, [active, runtimeBusy, uiStateKey, writeUiState]);
	const [backgroundVisualRetained, setBackgroundVisualRetained] =
		useState(active);
	useEffect(() => {
		if (active) {
			if (backgroundVisualRetained) return;
			const frame = requestAnimationFrame(() =>
				setBackgroundVisualRetained(true),
			);
			return () => cancelAnimationFrame(frame);
		}
		if (!retainBackgroundVisual) {
			if (!backgroundVisualRetained) return;
			const frame = requestAnimationFrame(() =>
				setBackgroundVisualRetained(false),
			);
			return () => cancelAnimationFrame(frame);
		}
		// A controller that was visible stays frozen for its whole background run.
		// Do not create a hidden visual tree for a session that was never opened.
		if (runtimeBusy || !backgroundVisualRetained) return;
		const timer = window.setTimeout(
			() => setBackgroundVisualRetained(false),
			BACKGROUND_VISUAL_RETENTION_MS,
		);
		return () => window.clearTimeout(timer);
	}, [active, backgroundVisualRetained, retainBackgroundVisual, runtimeBusy]);
	const renderVisual =
		active || (retainBackgroundVisual && backgroundVisualRetained);
	const visualReadyRef = useRef(false);
	const onVisualReadyChangeRef = useRef(onVisualReadyChange);
	useLayoutEffect(() => {
		onVisualReadyChangeRef.current = onVisualReadyChange;
	}, [onVisualReadyChange]);
	const handleVisualReady = useCallback(() => {
		if (visualReadyRef.current) return;
		visualReadyRef.current = true;
		onVisualReadyChange?.(true);
	}, [onVisualReadyChange]);
	useEffect(
		() => () => {
			if (visualReadyRef.current) onVisualReadyChangeRef.current?.(false);
		},
		[],
	);
	useLayoutEffect(() => {
		if (!visualReadyRef.current) return;
		// A retained, idle visual tree is still a valid warm cache. Invalidate it
		// only when the DOM is actually evicted or when a background run can make
		// the frozen transcript stale.
		if (renderVisual && (active || !runtimeBusy)) return;
		visualReadyRef.current = false;
		onVisualReadyChange?.(false);
	}, [active, onVisualReadyChange, renderVisual, runtimeBusy]);
	const piFeatures = usePiSessionFeatures({
		client,
		active,
		readOnly: session.externalRunning,
		onSetEditorText: setDraft,
		onRefreshSessionState: refreshSessionState,
	});
	const {
		commandSuggestions,
		loadCommands,
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
	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);
	const fileSuggestionCacheRef = useRef<Map<string, FileSuggestionCacheEntry>>(
		new Map(),
	);
	const handleSuggestionTrigger = useCallback(
		(trigger: "@" | "/" | null, query: string) => {
			fileSuggestionRequestRef.current += 1;
			const requestId = fileSuggestionRequestRef.current;
			if (fileSuggestionTimerRef.current !== null) {
				window.clearTimeout(fileSuggestionTimerRef.current);
				fileSuggestionTimerRef.current = null;
			}
			if (trigger === "/") {
				setFileSuggestions([]);
				if (!session.externalRunning) void loadCommands();
				return;
			}
			if (trigger !== "@") {
				setFileSuggestions([]);
				return;
			}
			const normalizedQuery = query.trim();
			const cacheKey = `${session.projectRecord.id}\0${normalizedQuery.toLowerCase()}`;
			const cached = fileSuggestionCacheRef.current.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				fileSuggestionCacheRef.current.delete(cacheKey);
				fileSuggestionCacheRef.current.set(cacheKey, cached);
				setFileSuggestions(cached.suggestions);
				return;
			}
			if (cached) fileSuggestionCacheRef.current.delete(cacheKey);

			fileSuggestionTimerRef.current = window.setTimeout(() => {
				fileSuggestionTimerRef.current = null;
				void searchProjectFiles(session.projectRecord.id, normalizedQuery)
					.then((paths) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						const suggestions = createFileSuggestions(paths, normalizedQuery);
						fileSuggestionCacheRef.current.set(cacheKey, {
							expiresAt: Date.now() + FILE_SUGGESTION_CACHE_TTL_MS,
							suggestions,
						});
						while (
							fileSuggestionCacheRef.current.size >
							FILE_SUGGESTION_CACHE_MAX_ENTRIES
						) {
							const oldestKey = fileSuggestionCacheRef.current
								.keys()
								.next().value;
							if (oldestKey === undefined) break;
							fileSuggestionCacheRef.current.delete(oldestKey);
						}
						setFileSuggestions(suggestions);
					})
					.catch((error) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						console.warn("Failed to load file suggestions", error);
						setFileSuggestions([]);
					});
			}, FILE_SUGGESTION_DEBOUNCE_MS);
		},
		[loadCommands, session.externalRunning, session.projectRecord.id],
	);
	useEffect(
		() => () => {
			fileSuggestionRequestRef.current += 1;
			if (fileSuggestionTimerRef.current !== null) {
				window.clearTimeout(fileSuggestionTimerRef.current);
			}
		},
		[],
	);
	const composerSuggestions = useMemo(
		() => [
			...fileSuggestions,
			...PI_SESSION_SUGGESTIONS,
			...commandSuggestions,
		],
		[commandSuggestions, fileSuggestions],
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
	const tryHandleComposerCommand = useCallback(
		async (submission: ChatSubmission) => {
			const command = submission.text.trim();
			if (!command.startsWith("/")) return false;
			const commandName = command.slice(1).split(/\s+/, 1)[0];

			if (commandName === "new") {
				clearDraft();
				setComposerImages([]);
				onNewChat?.();
				return true;
			}
			if (session.externalRunning) {
				toast.info("外部 Pi 正在运行，当前会话为只读观察模式");
				return true;
			}
			if (commandName === "compact") {
				if (running) {
					toast.info("当前回复完成后再压缩上下文");
					return true;
				}
				const customInstructions = command.slice("/compact".length).trim();
				clearDraft();
				setComposerImages([]);
				void compact(customInstructions || undefined);
				return true;
			}
			if (await tryExecuteExtensionCommand(command)) {
				clearDraft();
				setComposerImages([]);
				return true;
			}
			return false;
		},
		[
			clearDraft,
			compact,
			onNewChat,
			running,
			session.externalRunning,
			tryExecuteExtensionCommand,
		],
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
			void (async () => {
				if (session.externalRunning && submission.text.trim() !== "/new") {
					toast.info("外部 Pi 正在运行，当前会话为只读观察模式");
					return;
				}
				if (await tryHandleComposerCommand(submission)) return;
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
			})();
		},
		[
			clearDraft,
			handleSubmit,
			historySubmissionBlocked,
			persistDeferredHistorySubmissions,
			session.externalRunning,
			tryHandleComposerCommand,
		],
	);

	const handleForkAssistant = useCallback(
		async (messageId: string) => {
			if (
				forkingMessageId ||
				runtimeBusy ||
				historyPending ||
				session.temporary ||
				session.externalRunning
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
				const target = resolveAssistantForkTarget(
					getConversationMessages(),
					messageId,
					entries,
				);
				const forkRuntimeId = `fork-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				forkClient = createChatSessionClient(
					session.projectRecord.id,
					forkRuntimeId,
					sourceState.sessionFile,
					{ owner: "fork" },
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
				toast.error("Fork 新会话失败", {
					description: userErrorMessage(error),
				});
			} finally {
				await forkClient?.dispose("fork_cleanup").catch(() => undefined);
				setForkingMessageId(null);
			}
			if (forkedSession) onForkSessionCreated?.(forkedSession);
		},
		[
			client,
			forkingMessageId,
			historyPending,
			getConversationMessages,
			onForkSessionCreated,
			runtimeBusy,
			session.projectRecord.id,
			session.temporary,
			session.externalRunning,
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

	// Preserve the last painted visual tree for a busy/recent background chat so
	// switching back can reveal existing DOM immediately. The subscriber below is
	// frozen while inactive, so background Pi output still drives zero Markdown or
	// Virtua work. Idle snapshots expire to keep hidden DOM memory bounded.
	if (!renderVisual) return null;

	return (
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
					uiStateKey && readUiState ? readUiState(uiStateKey) : initialUiState;
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
							onExpandSidebar={onExpandSidebar}
							reserveWindowControls={reserveWindowControls}
							sidebarCollapsed={sidebarCollapsed}
							overlay={emptyTemporarySession}
						/>
						<div className="relative flex min-h-0 flex-1 flex-col">
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
										viewportUiState.virtualizerMessageCount === messages.length
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
										runtimeBusy || historyPending || Boolean(forkingMessageId)
									}
									suppressInterruptedError={session.externalRunning || running}
									onVisualReady={handleVisualReady}
									onRetry={onRetry}
									onRetryHistory={retryHistory}
								/>
							</ChatImageScopeProvider>

							{/* -mt-4 让滚动区底部上探 16px，消息在输入卡背后被自然裁切；
							    裁切线藏在卡片圆角(12px)以内，输入框下方缝隙不会露出消息 */}
							{/* 滚动区 scrollbar-gutter 恒为 stable（.chat-scrollbar），paddingRight
							    恒补偿 gutter 宽度，空会话 → 首条消息不再横跳 */}
							<div
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
									!session.externalRunning &&
									!running &&
									latestTurnInterrupted ? (
										<ChatInterruptedTurnNotice />
									) : null}
									<ChatRuntimeRecoveryNotice
										state={recoveryState}
										onReconnect={() => void handleReconnect()}
										onNewTemporaryChat={
											session.temporary ? onNewTemporaryChat : undefined
										}
									/>
									<PiExtensionNotifications
										notifications={extensionNotifications}
										onDismiss={dismissExtensionNotification}
									/>
									<ChatComposer
										value={session.externalRunning ? "" : draft}
										historyKey={session.projectRecord.id}
										placeholder={
											session.externalRunning
												? "外部 Pi 正在运行，当前会话暂不可输入"
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
											Boolean(session.externalRunning)
										}
										muted={Boolean(session.externalRunning)}
										running={running}
										onStop={handleStop}
										pendingSteering={pendingSteering}
										pendingFollowUps={pendingFollowUps}
										statusText={
											session.externalRunning
												? ""
												: [historyProgress, piStatusText]
														.filter(Boolean)
														.join(" · ")
										}
										compacting={compacting}
										retrying={retryState?.kind === "agent"}
										onAbortRetry={() => void abortRetry()}
										contextUsage={sessionState}
										suggestions={composerSuggestions}
										onSuggestionTrigger={handleSuggestionTrigger}
										models={modelOptions}
										selectedModel={selectedModel}
										modelLoading={modelLoadState === "loading"}
										modelError={modelError}
										modelDisabled={
											modelChanging ||
											runtimeBusy ||
											historyPending ||
											session.externalRunning
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
											session.externalRunning ||
											thinkingLevels.length === 0
										}
										onThinkingMenuOpen={() => void loadThinkingLevels()}
										onThinkingChange={handleThinkingChange}
									/>
								</ConversationColumn>
							</div>
						</div>
						<PiExtensionUiDialog
							request={extensionDialog}
							onRespond={(response) => void respondToExtensionDialog(response)}
						/>
					</div>
				);
			}}
		</ChatConversationSubscriber>
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
