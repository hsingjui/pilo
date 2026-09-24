import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Wifi, WifiOff, X } from "lucide-react";
import { toast } from "sonner";
import type { CacheSnapshot } from "virtua";

import {
	chatUiStateKey,
	toSidebarSession,
} from "@/components/app/app-chat-state";
import {
	createChatUiStateCache,
	createProjectDraftCache,
} from "@/components/app/chat-ui-state-cache";
import { ChatComposer } from "@/components/chat/chat-composer";
import {
	piSessionSuggestions,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer-suggestions";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { ChatConversationViewport } from "@/components/chat/chat-conversation-viewport";
import { ChatInterruptedTurnNotice } from "@/components/chat/chat-interrupted-turn-notice";
import { createChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";
import {
	alignHistoryMessages,
	buildHistoryPrefix,
	HISTORY_PAGE_MESSAGE_COUNT,
	HISTORY_PREFETCH_MESSAGES,
	INITIAL_HISTORY_MESSAGE_COUNT,
	sameHistoryFingerprint,
} from "@/components/chat/chat-history-window-utils";
import { ChatPendingQueue } from "@/components/chat/chat-pending-queue";
import { ChatRuntimeRecoveryNotice } from "@/components/chat/chat-runtime-recovery-notice";
import { useScrollbarGutterWidth } from "@/components/chat/use-scrollbar-gutter";
import { DraftProjectPicker } from "@/components/chat/draft-project-picker";
import { SessionHeader } from "@/components/chat/chat-session-header";
import type { ChatRuntimeRecoveryState } from "@/components/chat/chat-runtime-types";
import type {
	ChatSession,
	ChatSessionRuntimeState,
} from "@/components/chat/chat-page-utils";
import {
	ChatImageLightbox,
	ChatImageScopeProvider,
} from "@/components/chat/chat-image-viewer";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import {
	createConversationState,
	reduceConversationActions,
	replayConversationEvents,
} from "@/lib/conversation-reducer";
import type {
	ConversationAction,
	ConversationReducerContext,
	ConversationState,
} from "@/lib/conversation-types";
import { toConversationAction } from "@/lib/conversation-runtime-adapter";
import type { PiloClientEventMessage } from "@/lib/pilo-client";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
} from "@/lib/pi-command-suggestions";
import type {
	PiAgentState,
	PiCommand,
	PiCompactionResult,
	PiModel,
	PiSessionStats,
	PiThinkingLevel,
	PiloRuntimeEvent,
} from "@/lib/pi-runtime";
import { connectionLabel, type Project } from "@/lib/projects";
import type {
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/sessions";
import {
	summarizeChatImages,
	toPiImageContents,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { randomId } from "@/lib/utils";
import { Spinner, TooltipProvider } from "@/ui";
import {
	REMOTE_SEQUENCE_KEY,
	REMOTE_TOKEN_KEY,
	pairRemote,
} from "./remote-client";
import { RemoteMobileNavigation } from "./remote-mobile-navigation";
import { WebPiloClient } from "./web-pilo-client";

type RpcResponse<T = unknown> = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: T;
	error?: string;
};

const reducerContext: ConversationReducerContext = {
	createMessageId: (kind) => kind + "-" + randomId(),
	createContentId: (kind) => kind + "-" + randomId(),
	now: () => Date.now(),
	formatTime: (timestampMs) =>
		new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(timestampMs)),
};

function sessionLabel(session: SessionIndexEntry) {
	return (
		session.titleOverride ||
		session.name ||
		session.firstUserMessagePreview ||
		"Untitled session"
	);
}

function sessionKey(projectId: string, id: string) {
	return JSON.stringify([projectId, id]);
}

function isRpcResponse(value: unknown): value is RpcResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "response"
	);
}

function useMediaQuery(query: string) {
	const [matches, setMatches] = useState(
		() => typeof window !== "undefined" && window.matchMedia(query).matches,
	);
	useEffect(() => {
		const media = window.matchMedia(query);
		const onChange = () => setMatches(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

type RetryState = {
	kind: "agent" | "summary";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
};

// Scroll position survives session switches and reloads without a Host round trip.
const REMOTE_SCROLL_KEY_PREFIX = "pilo.remote.scroll.v1.";

function remoteScrollKey(routeSessionKey: string | null) {
	return REMOTE_SCROLL_KEY_PREFIX + (routeSessionKey ?? "draft");
}

function readRemoteScrollState(routeSessionKey: string | null) {
	try {
		const raw = window.localStorage.getItem(remoteScrollKey(routeSessionKey));
		if (!raw) return { scrollTop: 0, sticky: true };
		const parsed = JSON.parse(raw) as {
			scrollTop?: unknown;
			sticky?: unknown;
		};
		return {
			scrollTop: typeof parsed.scrollTop === "number" ? parsed.scrollTop : 0,
			sticky: typeof parsed.sticky === "boolean" ? parsed.sticky : true,
		};
	} catch {
		return { scrollTop: 0, sticky: true };
	}
}

function writeRemoteScrollState(
	routeSessionKey: string | null,
	state: { scrollTop: number; sticky: boolean },
) {
	try {
		window.localStorage.setItem(
			remoteScrollKey(routeSessionKey),
			JSON.stringify(state),
		);
	} catch {
		// Best-effort persistence; ignore quota or private-mode failures.
	}
}

export function RemoteApp() {
	const { t } = useTranslation();
	const pairingSecret = useMemo(
		() => new URLSearchParams(window.location.search).get("pair"),
		[],
	);
	const [token, setToken] = useState(() =>
		window.localStorage.getItem(REMOTE_TOKEN_KEY),
	);
	const client = useMemo(
		() => (token ? new WebPiloClient(token) : null),
		[token],
	);
	const [pairing, setPairing] = useState(Boolean(pairingSecret));
	const [fatalError, setFatalError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [reconnectKey, setReconnectKey] = useState(0);
	const [resyncKey, setResyncKey] = useState(0);
	const [projects, setProjects] = useState<Project[]>([]);
	const [rawSessions, setRawSessions] = useState<SessionIndexEntry[]>([]);
	const [refreshingProjectIds, setRefreshingProjectIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const [selectedSessionPath, setSelectedSessionPath] = useState<string | null>(
		null,
	);
	const [draftProjectId, setDraftProjectId] = useState("");
	const [draftId, setDraftId] = useState(() => randomId());
	const [identifiedDraftSessionId, setIdentifiedDraftSessionId] = useState<
		string | null
	>(null);
	const [conversation, setConversation] = useState<ConversationState>(() =>
		createConversationState(),
	);
	const [runtimeReady, setRuntimeReady] = useState(false);
	const [readOnly, setReadOnly] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [retryState, setRetryState] = useState<RetryState | null>(null);
	const [recoveryState, setRecoveryState] = useState<ChatRuntimeRecoveryState>({
		status: "idle",
		recoverable: true,
		messageKey: "",
	});
	const [historyRetryKey, setHistoryRetryKey] = useState(0);
	const [historyStore] = useState(createChatHistoryWindowStore);
	const historySnapshot = useSyncExternalStore(
		historyStore.subscribe,
		historyStore.getSnapshot,
		historyStore.getSnapshot,
	);
	const historyPageRequestsRef = useRef(new Set<number>());
	const [historyFingerprint, setHistoryFingerprint] =
		useState<SessionHistoryFingerprint | null>(null);
	const [loadingConversation, setLoadingConversation] = useState(false);
	const [composer, setComposer] = useState("");
	const [images, setImages] = useState<ChatImageAttachment[]>([]);
	const [chatUiStateCache] = useState(createChatUiStateCache);
	const [projectDraftCache] = useState(createProjectDraftCache);
	const [visualReadyRouteKey, setVisualReadyRouteKey] = useState<string | null>(
		null,
	);
	const [runtimeSessionKeys, setRuntimeSessionKeys] = useState<
		ReadonlyMap<string, string>
	>(() => new Map());
	const [agentState, setAgentState] = useState<PiAgentState | null>(null);
	const [chatState, setChatState] = useState<ChatSessionRuntimeState | null>(
		null,
	);
	const [models, setModels] = useState<PiModel[]>([]);
	const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>([]);
	const [draftModel, setDraftModel] = useState<PiModel | null>(null);
	const [draftThinkingLevel, setDraftThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const [sending, setSending] = useState(false);
	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const [commandSuggestions, setCommandSuggestions] = useState<
		ComposerSuggestion[]
	>([]);
	const extensionCommandNamesRef = useRef<Set<string>>(new Set());
	const commandsLoadedRef = useRef(false);
	const commandLoadingRef = useRef(false);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
	const isNarrow = useMediaQuery("(max-width: 1023px)");
	const scrollRef = useRef<HTMLDivElement>(null);
	// "chat-scrollbar" 预留 stable gutter，输入框不在滚动容器内，需补等宽内边距
	// 才能与消息列左右对齐（手机 overlay 滚动条为 0，仅在桌面浏览器可见）。
	const scrollbarWidth = useScrollbarGutterWidth(scrollRef, true);
	const activeSessionKeyRef = useRef<string | null>(null);
	const activeTurnRef = useRef(false);
	const rpcSequenceRef = useRef(0);
	const queuedSubmissionsRef = useRef(
		new Map<
			string,
			{ submission: ChatSubmission; queueKind: "steer" | "follow_up" }
		>(),
	);
	const draftCatalogRequestRef = useRef(0);
	const autoTitleRequestedRef = useRef(false);
	const refreshAllSessionsRef = useRef<(() => Promise<void>) | null>(null);
	const refreshAgentConfigRef = useRef<(() => Promise<void>) | null>(null);
	const pendingRpcRef = useRef(
		new Map<
			string,
			{
				resolve: (value: unknown) => void;
				reject: (reason?: unknown) => void;
				timer: number;
			}
		>(),
	);

	const selectedSession = useMemo(
		() =>
			rawSessions.find(
				(session) => session.sessionPath === selectedSessionPath,
			) ?? null,
		[rawSessions, selectedSessionPath],
	);
	const identifiedDraftSession = useMemo(
		() =>
			rawSessions.find(
				(session) => session.piSessionId === identifiedDraftSessionId,
			) ?? null,
		[identifiedDraftSessionId, rawSessions],
	);
	const activeProjectId =
		selectedSession?.projectId ??
		identifiedDraftSession?.projectId ??
		draftProjectId;
	const activeProject = useMemo(
		() => projects.find((project) => project.id === activeProjectId) ?? null,
		[projects, activeProjectId],
	);
	const hasIdentifiedSession = Boolean(
		selectedSession || identifiedDraftSessionId,
	);
	const identifiedSessionId =
		selectedSession?.piSessionId ?? identifiedDraftSessionId;
	const activeSessionKey = activeProjectId
		? selectedSession
			? (runtimeSessionKeys.get(selectedSession.piSessionId) ??
				sessionKey(activeProjectId, selectedSession.piSessionId))
			: sessionKey(activeProjectId, draftId)
		: null;
	const routeSessionId =
		selectedSession?.piSessionId ?? identifiedDraftSessionId ?? draftId;
	const routeUiKey = activeProjectId
		? chatUiStateKey(activeProjectId, routeSessionId)
		: "remote-draft";
	const initialUiState = useMemo(
		() => chatUiStateCache.get(routeUiKey),
		[chatUiStateCache, routeUiKey],
	);

	const headerSession = useMemo<ChatSession | null>(() => {
		if (!activeProject) return null;
		const displaySession = selectedSession ?? identifiedDraftSession;
		if (!displaySession && !identifiedDraftSessionId) return null;
		if (!displaySession) {
			return {
				id: identifiedDraftSessionId!,
				title: agentState?.sessionName?.trim() || t("app.newChat"),
				projectRecord: activeProject,
				sessionPath: agentState?.sessionFile,
			};
		}
		return {
			id: displaySession.piSessionId,
			title: sessionLabel(displaySession),
			projectRecord: activeProject,
			sessionPath: displaySession.sessionPath,
		};
	}, [
		activeProject,
		agentState?.sessionFile,
		agentState?.sessionName,
		identifiedDraftSession,
		identifiedDraftSessionId,
		selectedSession,
		t,
	]);

	const historyPrefix = useMemo(
		() => buildHistoryPrefix(historySnapshot),
		[historySnapshot],
	);
	const visibleMessages = useMemo(
		() =>
			historyPrefix.length > 0
				? [...historyPrefix, ...conversation.messages]
				: conversation.messages,
		[conversation.messages, historyPrefix],
	);
	const activeAssistantMessageId =
		conversation.active?.assistantMessageId ?? null;
	const latestTurnInterrupted = useMemo(() => {
		for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
			const message = conversation.messages[index];
			if (message?.role === "assistant" && !message.historyPlaceholder) {
				return message.completion === "interrupted";
			}
		}
		return false;
	}, [conversation.messages]);
	const composerStatusText = retryState
		? t("chat.statusRetry", {
				kind:
					retryState.kind === "summary"
						? t("chat.kindSummary")
						: t("chat.kindRequest"),
				attempt: retryState.attempt,
				maxAttempts: retryState.maxAttempts,
			})
		: "";

	useEffect(() => {
		activeSessionKeyRef.current = activeSessionKey;
	}, [activeSessionKey]);
	useEffect(() => {
		activeTurnRef.current = conversation.active !== null;
	}, [conversation.active]);
	useEffect(() => {
		if (recoveryState.status !== "recovered") return;
		const timer = window.setTimeout(
			() =>
				setRecoveryState({
					status: "idle",
					recoverable: true,
					messageKey: "",
				}),
			2_500,
		);
		return () => window.clearTimeout(timer);
	}, [recoveryState.status]);
	const routeKey = activeSessionKey ?? routeUiKey;
	const initialScrollState = useMemo(
		() => readRemoteScrollState(routeUiKey),
		[routeUiKey],
	);
	const persistScrollState = useCallback(
		(state: { scrollTop: number; sticky: boolean }) => {
			chatUiStateCache.patch(routeUiKey, state);
			writeRemoteScrollState(routeUiKey, state);
		},
		[chatUiStateCache, routeUiKey],
	);
	const persistVirtualizerCache = useCallback(
		(cache: CacheSnapshot, messageCount: number) => {
			chatUiStateCache.patch(routeUiKey, {
				virtualizerCache: cache,
				virtualizerMessageCount: messageCount,
			});
		},
		[chatUiStateCache, routeUiKey],
	);
	const handleVisualReady = useCallback(() => {
		setVisualReadyRouteKey(activeSessionKey);
	}, [activeSessionKey]);
	const showSwitchSkeleton =
		Boolean(selectedSession) && visualReadyRouteKey !== activeSessionKey;
	const handleComposerChange = useCallback(
		(value: string) => {
			setComposer(value);
			if (!activeProjectId) return;
			if (hasIdentifiedSession) {
				chatUiStateCache.patch(routeUiKey, { draft: value });
			} else {
				projectDraftCache.set(activeProjectId, value);
			}
		},
		[
			activeProjectId,
			chatUiStateCache,
			hasIdentifiedSession,
			projectDraftCache,
			routeUiKey,
		],
	);
	const clearComposer = useCallback(() => {
		handleComposerChange("");
		setImages([]);
	}, [handleComposerChange]);
	const historyImageScope = useMemo(
		() =>
			client && selectedSession && activeProjectId
				? {
						projectId: activeProjectId,
						sessionPath: selectedSession.sessionPath,
						fingerprint: historyFingerprint,
						readImage: client.readHistoryImage.bind(client),
					}
				: null,
		[activeProjectId, client, historyFingerprint, selectedSession],
	);

	const reconnectNow = useCallback(() => {
		setRecoveryState({
			status: "reconnecting",
			recoverable: true,
			messageKey: "chat.reconnecting",
		});
		setReconnectKey((value) => value + 1);
	}, []);

	const envs = useMemo(() => {
		const byId = new Map<string, { id: string; name: string }>();
		for (const project of projects) {
			byId.set(project.connection.id, {
				id: project.connection.id,
				name: connectionLabel(project.connection),
			});
		}
		const list = [...byId.values()];
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [projects]);

	const sidebarProjects = useMemo(
		() =>
			projects.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.metadata.cwd,
				envId: project.connection.id,
				connectionType: project.connection.kind.type,
			})),
		[projects],
	);

	const sidebarSessions = useMemo(
		() => rawSessions.map(toSidebarSession),
		[rawSessions],
	);

	const composerSuggestions = useMemo(
		() => [
			...fileSuggestions,
			...piSessionSuggestions(t),
			...commandSuggestions,
		],
		[commandSuggestions, fileSuggestions, t],
	);

	const selectedModel = useMemo(() => {
		if (!hasIdentifiedSession) return draftModel;
		const current = agentState?.model;
		if (!current) return null;
		return (
			models.find(
				(model) =>
					model.provider === current.provider && model.id === current.id,
			) ?? null
		);
	}, [agentState?.model, draftModel, hasIdentifiedSession, models]);

	// Draft run-config mirrors the Desktop landing page: thinking levels come from
	// the cached per-model profile instead of a live Pi session.
	const composerThinkingLevels = selectedSession
		? thinkingLevels
		: (draftModel?.thinkingLevels ?? []);
	const composerSelectedThinkingLevel = selectedSession
		? (agentState?.thinkingLevel ?? null)
		: draftThinkingLevel;

	const loadDraftCatalog = useCallback(
		(projectId: string) => {
			const requestId = ++draftCatalogRequestRef.current;
			return (client?.loadModels(projectId) ?? Promise.resolve(null))
				.then((catalog) => {
					if (draftCatalogRequestRef.current !== requestId || !catalog) return;
					setModels(catalog.models);
					setDraftModel((current) => current ?? catalog.defaultModel);
					setDraftThinkingLevel(
						(current) => current ?? catalog.defaultThinkingLevel,
					);
				})
				.catch((error) => {
					if (draftCatalogRequestRef.current !== requestId) return;
					console.warn("Failed to load remote model catalog", error);
				});
		},
		[client],
	);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- The draft landing page preloads the Host-cached Pi model catalog, and draftId intentionally retriggers it for every new draft. */
	useEffect(() => {
		void draftId;
		if (selectedSession || !activeProjectId) return;
		void loadDraftCatalog(activeProjectId);
		return () => {
			draftCatalogRequestRef.current += 1;
		};
	}, [activeProjectId, draftId, loadDraftCatalog, selectedSession]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	const handleExpiredAuth = useCallback(
		(error: unknown) => {
			if (error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED") {
				window.localStorage.removeItem(REMOTE_TOKEN_KEY);
				setToken(null);
				setFatalError(t("settings.remoteAuthorizationExpired"));
				return true;
			}
			return false;
		},
		[t],
	);

	useEffect(() => {
		if (!pairingSecret) return;
		let cancelled = false;
		void pairRemote(pairingSecret)
			.then((result) => {
				if (cancelled) return;
				window.localStorage.setItem(REMOTE_TOKEN_KEY, result.token);
				window.history.replaceState({}, "", window.location.pathname);
				setToken(result.token);
				setFatalError(null);
			})
			.catch((error) => {
				if (!cancelled)
					setFatalError(String(error instanceof Error ? error.message : error));
			})
			.finally(() => {
				if (!cancelled) setPairing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [pairingSecret]);

	const reloadBootstrap = useCallback(async () => {
		if (!client) return;
		try {
			const bootstrap = await client.bootstrap();
			setProjects(bootstrap.projects);
		} catch (error) {
			if (!handleExpiredAuth(error)) {
				setFatalError(error instanceof Error ? error.message : String(error));
			}
		}
	}, [client, handleExpiredAuth]);

	const refreshProjectSessions = useCallback(
		async (projectId: string, showProgress = false) => {
			if (!client) return;
			if (showProgress) {
				setRefreshingProjectIds((current) => {
					if (current.has(projectId)) return current;
					const next = new Set(current);
					next.add(projectId);
					return next;
				});
			}
			try {
				const next = await client.listSessions(projectId);
				setRawSessions((current) => [
					...current.filter((session) => session.projectId !== projectId),
					...next,
				]);
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					console.debug("Failed to refresh remote sessions", error);
				}
			} finally {
				if (showProgress) {
					setRefreshingProjectIds((current) => {
						if (!current.has(projectId)) return current;
						const next = new Set(current);
						next.delete(projectId);
						return next;
					});
				}
			}
		},
		[client, handleExpiredAuth],
	);

	const refreshAllSessions = useCallback(async () => {
		if (!client || projects.length === 0) {
			setRawSessions([]);
			return;
		}
		const results = await Promise.allSettled(
			projects.map((project) => client.listSessions(project.id)),
		);
		const next: SessionIndexEntry[] = [];
		for (const result of results) {
			if (result.status === "fulfilled") next.push(...result.value);
		}
		setRawSessions(next);
	}, [client, projects]);

	useEffect(() => {
		refreshAllSessionsRef.current = refreshAllSessions;
	}, [refreshAllSessions]);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Bootstrap and the resync generation intentionally retrigger synchronization with the external Remote Host snapshot. */
	useEffect(() => {
		void resyncKey;
		void reloadBootstrap();
	}, [reloadBootstrap, resyncKey]);
	useEffect(() => {
		void resyncKey;
		void refreshAllSessions();
	}, [refreshAllSessions, resyncKey]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	/* oxlint-disable react/set-state-in-effect -- Defaulting the draft project to the first available Host project. */
	useEffect(() => {
		if (draftProjectId || projects.length === 0) return;
		setDraftProjectId(projects[0].id);
	}, [draftProjectId, projects]);
	/* oxlint-enable react/set-state-in-effect */

	const handleSocketMessage = useCallback((message: PiloClientEventMessage) => {
		if (message.type === "resyncRequired") {
			window.localStorage.setItem(
				REMOTE_SEQUENCE_KEY,
				String(message.latestSequence),
			);
			setResyncKey((value) => value + 1);
			return;
		}
		if (message.type !== "events") return;
		let lastSequence = 0;
		const actions: ConversationAction[] = [];
		for (const event of message.events) {
			lastSequence = Math.max(lastSequence, event.sequence);
			if (event.type === "rpc_message" && isRpcResponse(event.message)) {
				const id = event.message.id;
				if (id) {
					const pending = pendingRpcRef.current.get(id);
					if (pending) {
						window.clearTimeout(pending.timer);
						pendingRpcRef.current.delete(id);
						if (event.message.success) pending.resolve(event.message.data);
						else
							pending.reject(
								new Error(event.message.error || "Pi command failed"),
							);
					}
				}
			}
			if (event.sessionKey !== activeSessionKeyRef.current) continue;
			switch (event.type) {
				case "compaction_start":
					setCompacting(true);
					break;
				case "compaction_end":
					setCompacting(false);
					break;
				case "auto_retry_start":
					setRetryState({
						kind: "agent",
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs,
						errorMessage: event.errorMessage,
					});
					break;
				case "auto_retry_end":
					setRetryState(null);
					break;
				case "summarization_retry_scheduled":
					setRetryState({
						kind: "summary",
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs,
						errorMessage: event.errorMessage,
					});
					break;
				case "summarization_retry_finished":
					setRetryState(null);
					break;
			}
			const action = toConversationAction(event as PiloRuntimeEvent);
			if (action) actions.push(action);
			if (event.type === "assistant_message_end") {
				window.setTimeout(() => {
					void refreshAllSessionsRef.current?.();
					void refreshAgentConfigRef.current?.();
				}, 500);
			}
		}
		if (lastSequence > 0) {
			window.localStorage.setItem(REMOTE_SEQUENCE_KEY, String(lastSequence));
		}
		if (actions.length > 0) {
			setConversation((current) => {
				let next = current;
				for (const action of actions) {
					if (action.type === "user_message_start") {
						const pending = next.pendingUsers[0];
						if (pending?.queueKind) {
							queuedSubmissionsRef.current.delete(pending.clientMessageId);
						}
					}
					next = reduceConversationActions(next, [action], reducerContext);
				}
				return next;
			});
		}
	}, []);

	/* oxlint-disable react/exhaustive-effect-dependencies -- reconnectKey is an explicit retry generation used only to recreate the external WebSocket. */
	useEffect(() => {
		void reconnectKey;
		if (!client) return;
		let cancelled = false;
		let disconnect: (() => void) | undefined;
		let reconnectTimer: number | undefined;
		const stored = Number(
			window.localStorage.getItem(REMOTE_SEQUENCE_KEY) ?? "0",
		);
		void client
			.connectEvents({
				after: Number.isFinite(stored) && stored > 0 ? stored : undefined,
				onMessage: handleSocketMessage,
				onStatus: (isConnected) => {
					if (cancelled) return;
					setConnected(isConnected);
					setRecoveryState((current) => {
						if (!isConnected) {
							return {
								status: "reconnecting",
								recoverable: true,
								messageKey: "chat.reconnecting",
							};
						}
						if (current.status === "reconnecting") {
							return {
								status: "recovered",
								recoverable: true,
								messageKey: "chat.reconnected",
							};
						}
						return current;
					});
					if (!isConnected && reconnectTimer === undefined) {
						reconnectTimer = window.setTimeout(
							() => setReconnectKey((value) => value + 1),
							1_500,
						);
					}
				},
			})
			.then((stop) => {
				if (cancelled) stop();
				else disconnect = stop;
			})
			.catch((error) => {
				if (!cancelled && !handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			});
		return () => {
			cancelled = true;
			if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
			disconnect?.();
		};
	}, [client, handleExpiredAuth, handleSocketMessage, reconnectKey]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const rpcForSession = useCallback(
		async <T,>(
			targetSessionKey: string,
			command: Record<string, unknown>,
			timeoutMs = 10_000,
		): Promise<T> => {
			if (!client) throw new Error("Chat is not ready");
			rpcSequenceRef.current += 1;
			const id = "remote-" + Date.now() + "-" + String(rpcSequenceRef.current);
			const response = new Promise<T>((resolve, reject) => {
				const timer = window.setTimeout(() => {
					pendingRpcRef.current.delete(id);
					reject(new Error("Pi command timed out"));
				}, timeoutMs);
				pendingRpcRef.current.set(id, {
					resolve: (value) => resolve(value as T),
					reject,
					timer,
				});
			});
			try {
				await client.sendChatCommand(targetSessionKey, { ...command, id });
			} catch (error) {
				const pending = pendingRpcRef.current.get(id);
				if (pending) {
					window.clearTimeout(pending.timer);
					pendingRpcRef.current.delete(id);
					pending.reject(error);
				}
			}
			return response;
		},
		[client],
	);

	const rpc = useCallback(
		<T,>(command: Record<string, unknown>, timeoutMs = 10_000) => {
			const targetSessionKey = activeSessionKeyRef.current;
			if (!targetSessionKey) throw new Error("Chat is not ready");
			return rpcForSession<T>(targetSessionKey, command, timeoutMs);
		},
		[rpcForSession],
	);

	const refreshAgentConfig = useCallback(async () => {
		try {
			const [state, modelResult, thinkingResult, stats] = await Promise.all([
				rpc<PiAgentState>({ type: "get_state" }),
				rpc<{ models: PiModel[] }>({ type: "get_available_models" }),
				rpc<{ levels: PiThinkingLevel[] }>({
					type: "get_available_thinking_levels",
				}),
				rpc<PiSessionStats>({ type: "get_session_stats" }),
			]);
			setAgentState(state);
			setModels(modelResult.models);
			setThinkingLevels(thinkingResult.levels);
			setChatState({
				name: state.sessionName,
				tokens: stats.tokens,
				cost: stats.cost,
				contextTokens: stats.contextUsage?.tokens,
				contextWindow: stats.contextUsage?.contextWindow,
				contextPercent: stats.contextUsage?.percent,
			});
		} catch {
			// Optional model metadata can fail while the chat stream remains usable.
		}
	}, [rpc]);

	useEffect(() => {
		refreshAgentConfigRef.current = refreshAgentConfig;
	}, [refreshAgentConfig]);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Selecting a Host session or changing the resync generation intentionally replaces local replay state with the authoritative history snapshot. */
	useEffect(() => {
		void resyncKey;
		if (!client || !activeProjectId || !selectedSession) {
			if (!selectedSession) {
				setConversation(createConversationState());
				historyStore.initialize([], 0);
				historyPageRequestsRef.current.clear();
				setHistoryFingerprint(null);
				setRuntimeReady(false);
				setReadOnly(false);
				setAgentState(null);
				setChatState(null);
			}
			return;
		}
		let cancelled = false;
		setLoadingConversation(true);
		setRuntimeReady(false);
		setReadOnly(false);
		void client
			.loadHistory(activeProjectId, selectedSession.sessionPath, {
				messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
				includeMessageIndex: true,
			})
			.then((result: SessionHistoryResult) => {
				if (cancelled) return;
				const directory = result.history.messageIndex;
				const windowStart = result.history.windowStartMessage;
				if (!directory || windowStart === undefined) {
					throw new Error(
						"Session history window is missing its message index.",
					);
				}
				setHistoryFingerprint(result.fingerprint);
				historyPageRequestsRef.current.clear();
				historyStore.initialize(directory, windowStart);
				let state = replayConversationEvents(
					result.history.events,
					reducerContext,
				);
				state = alignHistoryMessages(state, directory, windowStart);
				setConversation(state);
				return client.startChat({
					projectId: activeProjectId,
					sessionKey:
						activeSessionKey ??
						sessionKey(activeProjectId, selectedSession.piSessionId),
					sessionPath: selectedSession.sessionPath,
				});
			})
			.then(() => {
				if (cancelled) return;
				setRuntimeReady(true);
				void refreshAgentConfig();
			})
			.catch((error) => {
				if (cancelled || handleExpiredAuth(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("read-only observer mode")) {
					setReadOnly(true);
					return;
				}
				setFatalError(message);
			})
			.finally(() => {
				if (!cancelled) setLoadingConversation(false);
			});
		return () => {
			cancelled = true;
		};
	}, [
		activeProjectId,
		activeSessionKey,
		handleExpiredAuth,
		refreshAgentConfig,
		resyncKey,
		historyRetryKey,
		selectedSession,
		client,
		historyStore,
	]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	const requestHistoryRange = useCallback(
		(startIndex: number, endIndex: number) => {
			if (
				!client ||
				!activeProjectId ||
				!selectedSession ||
				!historyFingerprint
			) {
				return;
			}
			const snapshot = historyStore.getSnapshot();
			if (snapshot.runtimeBaseStart <= 0) return;
			const prefetchStart = Math.max(0, startIndex - HISTORY_PREFETCH_MESSAGES);
			const prefetchEnd = Math.min(
				snapshot.runtimeBaseStart - 1,
				endIndex + HISTORY_PREFETCH_MESSAGES,
			);
			historyStore.setPinnedRange(prefetchStart, prefetchEnd);
			if (prefetchEnd < prefetchStart) return;
			const firstPage =
				Math.floor(prefetchStart / HISTORY_PAGE_MESSAGE_COUNT) *
				HISTORY_PAGE_MESSAGE_COUNT;
			const lastPage =
				Math.floor(prefetchEnd / HISTORY_PAGE_MESSAGE_COUNT) *
				HISTORY_PAGE_MESSAGE_COUNT;
			for (
				let pageStart = firstPage;
				pageStart <= lastPage;
				pageStart += HISTORY_PAGE_MESSAGE_COUNT
			) {
				const pageEnd = Math.min(
					snapshot.runtimeBaseStart - 1,
					pageStart + HISTORY_PAGE_MESSAGE_COUNT - 1,
				);
				if (
					historyStore.isRangeHydrated(pageStart, pageEnd) ||
					historyPageRequestsRef.current.has(pageStart)
				) {
					continue;
				}
				historyPageRequestsRef.current.add(pageStart);
				void client
					.loadHistory(activeProjectId, selectedSession.sessionPath, {
						startMessage: pageStart,
						messageLimit: pageEnd - pageStart + 1,
						includeMessageIndex: false,
						fingerprint: historyFingerprint,
					})
					.then((result) => {
						if (
							!sameHistoryFingerprint(historyFingerprint, result.fingerprint)
						) {
							setHistoryRetryKey((value) => value + 1);
							return;
						}
						let state = replayConversationEvents(
							result.history.events,
							reducerContext,
						);
						const actualStart = result.history.windowStartMessage ?? pageStart;
						state = alignHistoryMessages(
							state,
							historyStore.getSnapshot().directory,
							actualStart,
						);
						historyStore.hydrate(actualStart, state.messages);
					})
					.catch((error) => {
						if (!handleExpiredAuth(error)) {
							console.warn("Failed to hydrate remote history window", error);
						}
					})
					.finally(() => historyPageRequestsRef.current.delete(pageStart));
			}
		},
		[
			activeProjectId,
			client,
			handleExpiredAuth,
			historyFingerprint,
			historyStore,
			selectedSession,
		],
	);

	const startDraft = useCallback(
		(projectId?: string) => {
			const targetProjectId = projectId ?? activeProjectId ?? "";
			queuedSubmissionsRef.current.clear();
			setSelectedSessionPath(null);
			setIdentifiedDraftSessionId(null);
			setDraftId(randomId());
			setConversation(createConversationState());
			historyStore.initialize([], 0);
			historyPageRequestsRef.current.clear();
			setHistoryFingerprint(null);
			setRuntimeReady(false);
			setReadOnly(false);
			setAgentState(null);
			setChatState(null);
			setModels([]);
			setThinkingLevels([]);
			setDraftModel(null);
			setDraftThinkingLevel(null);
			setComposer(
				targetProjectId ? projectDraftCache.get(targetProjectId) : "",
			);
			setImages([]);
			autoTitleRequestedRef.current = false;
			setVisualReadyRouteKey(null);
			if (targetProjectId) setDraftProjectId(targetProjectId);
			if (isNarrow) setMobileNavigationOpen(false);
		},
		[activeProjectId, historyStore, isNarrow, projectDraftCache],
	);

	const handleSelectSession = useCallback(
		(sessionId: string) => {
			const session = rawSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			if (!session) return;
			if (
				session.piSessionId === identifiedDraftSessionId &&
				selectedSessionPath === null
			) {
				if (isNarrow) setMobileNavigationOpen(false);
				return;
			}
			queuedSubmissionsRef.current.clear();
			setLoadingConversation(true);
			setSelectedSessionPath(session.sessionPath);
			setDraftProjectId(session.projectId);
			setComposer(
				chatUiStateCache.get(
					chatUiStateKey(session.projectId, session.piSessionId),
				).draft,
			);
			setImages([]);
			setVisualReadyRouteKey(null);
			if (isNarrow) setMobileNavigationOpen(false);
		},
		[
			chatUiStateCache,
			identifiedDraftSessionId,
			isNarrow,
			rawSessions,
			selectedSessionPath,
		],
	);

	const identifyDraftSession = useCallback(
		(state: PiAgentState) => {
			if (selectedSession || !activeProjectId || !state.sessionId) return;
			const previousKey = chatUiStateKey(activeProjectId, draftId);
			const nextKey = chatUiStateKey(activeProjectId, state.sessionId);
			chatUiStateCache.rekey(previousKey, nextKey);
			setRuntimeSessionKeys((current) => {
				const next = new Map(current);
				next.set(state.sessionId!, sessionKey(activeProjectId, draftId));
				return next;
			});
			setIdentifiedDraftSessionId(state.sessionId);
			void refreshProjectSessions(activeProjectId, true);
		},
		[
			activeProjectId,
			chatUiStateCache,
			draftId,
			refreshProjectSessions,
			selectedSession,
		],
	);

	const ensureDraftRuntime = useCallback(async () => {
		if (!client || !activeProjectId || !activeSessionKey)
			throw new Error("Choose a project first");
		if (runtimeReady) {
			if (!selectedSession && !identifiedDraftSessionId) {
				const state = await rpc<PiAgentState>({ type: "get_state" });
				setAgentState(state);
				identifyDraftSession(state);
			}
			return;
		}
		await client.startChat({
			projectId: activeProjectId,
			sessionKey: activeSessionKey,
		});
		setRuntimeReady(true);
		// Carry the draft run-config onto the freshly started session, matching the
		// Desktop `prepareRuntimeConfiguration` step for new chats. Selected sessions
		// keep whatever model Pi already restored.
		if (!selectedSession && draftModel) {
			await rpc<PiModel>({
				type: "set_model",
				provider: draftModel.provider,
				modelId: draftModel.id,
			}).catch(() => undefined);
		}
		if (!selectedSession && draftThinkingLevel) {
			await rpc<void>({
				type: "set_thinking_level",
				level: draftThinkingLevel,
			}).catch(() => undefined);
		}
		if (!selectedSession) {
			const state = await rpc<PiAgentState>({ type: "get_state" });
			setAgentState(state);
			identifyDraftSession(state);
		}
		window.setTimeout(() => void refreshAgentConfig(), 50);
	}, [
		activeProjectId,
		activeSessionKey,
		client,
		draftModel,
		draftThinkingLevel,
		identifiedDraftSessionId,
		identifyDraftSession,
		refreshAgentConfig,
		rpc,
		runtimeReady,
		selectedSession,
	]);

	const requestAutoTitle = useCallback(
		(message: string) => {
			const prompt = message.trim();
			if (
				!client ||
				!activeProjectId ||
				!activeSessionKey ||
				selectedSession ||
				autoTitleRequestedRef.current ||
				!prompt
			) {
				return;
			}
			autoTitleRequestedRef.current = true;
			const targetSessionKey = activeSessionKey;
			void client
				.generateSessionTitle(activeProjectId, prompt)
				.then(async (title) => {
					if (!title) return;
					const state = await rpcForSession<PiAgentState>(targetSessionKey, {
						type: "get_state",
					});
					if (state.sessionName?.trim()) return;
					await rpcForSession<void>(targetSessionKey, {
						type: "set_session_name",
						name: title,
					});
					if (activeSessionKeyRef.current === targetSessionKey) {
						setAgentState((current) =>
							current ? { ...current, sessionName: title } : current,
						);
						setChatState((current) =>
							current ? { ...current, name: title } : current,
						);
					}
					void refreshProjectSessions(activeProjectId, true);
				})
				.catch((error) => {
					if (!handleExpiredAuth(error)) {
						console.warn("Failed to generate remote session title", error);
					}
				});
		},
		[
			activeProjectId,
			activeSessionKey,
			client,
			handleExpiredAuth,
			refreshProjectSessions,
			rpcForSession,
			selectedSession,
		],
	);

	const loadCommands = useCallback(async () => {
		if (commandsLoadedRef.current || commandLoadingRef.current || readOnly)
			return;
		commandLoadingRef.current = true;
		try {
			await ensureDraftRuntime();
			const result = await rpc<{ commands: PiCommand[] }>({
				type: "get_commands",
			});
			extensionCommandNamesRef.current = createPiExtensionCommandNames(
				result.commands,
			);
			setCommandSuggestions(createPiCommandSuggestions(result.commands));
			commandsLoadedRef.current = true;
		} catch (error) {
			console.warn("Failed to load Pi commands for remote composer", error);
		} finally {
			commandLoadingRef.current = false;
		}
	}, [ensureDraftRuntime, readOnly, rpc]);

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
				void loadCommands();
				return;
			}
			if (trigger !== "@" || !client || !activeProjectId) {
				setFileSuggestions([]);
				return;
			}
			const normalizedQuery = query.trim();
			fileSuggestionTimerRef.current = window.setTimeout(() => {
				fileSuggestionTimerRef.current = null;
				void client
					.searchFiles(activeProjectId, normalizedQuery)
					.then((paths) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						setFileSuggestions(createFileSuggestions(paths, normalizedQuery));
					})
					.catch((error) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						console.warn("Failed to load remote file suggestions", error);
						setFileSuggestions([]);
					});
			}, 120);
		},
		[activeProjectId, client, loadCommands],
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

	const tryHandleComposerCommand = useCallback(
		async (submission: ChatSubmission) => {
			if (!submission.text.startsWith("/")) return false;
			const command = submission.text.trim();
			const commandName = command.slice(1).split(/\s+/, 1)[0];
			if (commandName === "new") {
				clearComposer();
				startDraft(activeProjectId || undefined);
				return true;
			}
			if (!client || !activeSessionKey) return false;
			if (commandName === "compact") {
				const customInstructions = command.slice("/compact".length).trim();
				clearComposer();
				try {
					await ensureDraftRuntime();
					const result = await rpc<PiCompactionResult>(
						{
							type: "compact",
							...(customInstructions ? { customInstructions } : {}),
						},
						120_000,
					);
					toast.success(t("chat.compactSuccess"), {
						description: `${result.tokensBefore.toLocaleString()} → ${result.estimatedTokensAfter.toLocaleString()} tokens`,
					});
				} catch (error) {
					if (!handleExpiredAuth(error)) {
						setFatalError(
							error instanceof Error ? error.message : String(error),
						);
					}
				}
				return true;
			}
			let extensionNames = extensionCommandNamesRef.current;
			if (!commandsLoadedRef.current) {
				try {
					await ensureDraftRuntime();
					const result = await rpc<{ commands: PiCommand[] }>({
						type: "get_commands",
					});
					extensionNames = createPiExtensionCommandNames(result.commands);
					extensionCommandNamesRef.current = extensionNames;
					setCommandSuggestions(createPiCommandSuggestions(result.commands));
					commandsLoadedRef.current = true;
				} catch {
					return false;
				}
			}
			if (!extensionNames.has(commandName)) return false;
			clearComposer();
			try {
				await client.sendChatCommand(activeSessionKey, {
					type: "prompt",
					message: command,
				});
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			}
			return true;
		},
		[
			activeProjectId,
			activeSessionKey,
			clearComposer,
			client,
			ensureDraftRuntime,
			handleExpiredAuth,
			rpc,
			startDraft,
			t,
		],
	);

	const runLocalAction = useCallback((action: ConversationAction) => {
		setConversation((current) =>
			reduceConversationActions(current, [action], reducerContext),
		);
	}, []);

	const sendSubmission = useCallback(
		async (
			submission: ChatSubmission,
			mode: "prompt" | "steer" | "follow_up",
		) => {
			if (!client || !activeSessionKey || readOnly) return;
			if (!submission.text.trim() && submission.images.length === 0) return;
			if (mode === "prompt" && (await tryHandleComposerCommand(submission)))
				return;
			const shouldAutoTitle =
				mode === "prompt" && !selectedSession && !autoTitleRequestedRef.current;
			let queuedClientMessageId: string | null = null;
			setSending(true);
			try {
				await ensureDraftRuntime();
				const now = Date.now();
				const clientMessageId = randomId();
				const descriptors = summarizeChatImages(submission.images);
				if (mode === "prompt") {
					runLocalAction({
						type: "local_user_submit",
						clientMessageId,
						text: submission.text,
						images: descriptors,
						timestampMs: now,
					});
				} else {
					queuedClientMessageId = clientMessageId;
					queuedSubmissionsRef.current.set(clientMessageId, {
						submission,
						queueKind: mode,
					});
					runLocalAction({
						type: "local_user_queue",
						clientMessageId,
						text: submission.text,
						images: descriptors,
						queueKind: mode,
						timestampMs: now,
					});
				}
				clearComposer();
				await client.sendChatCommand(activeSessionKey, {
					type: mode,
					message: submission.text,
					images: toPiImageContents(submission.images),
				});
				if (shouldAutoTitle) requestAutoTitle(submission.text);
			} catch (error) {
				if (queuedClientMessageId) {
					queuedSubmissionsRef.current.delete(queuedClientMessageId);
					runLocalAction({
						type: "local_user_queue_failed",
						clientMessageId: queuedClientMessageId,
					});
				}
				handleComposerChange(submission.text);
				setImages(submission.images);
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSending(false);
			}
		},
		[
			activeSessionKey,
			clearComposer,
			client,
			ensureDraftRuntime,
			handleComposerChange,
			handleExpiredAuth,
			readOnly,
			requestAutoTitle,
			runLocalAction,
			selectedSession,
			tryHandleComposerCommand,
		],
	);

	const handleEditQueued = useCallback(
		async (clientMessageId: string) => {
			if (!client || !activeSessionKey) return;
			const item = queuedSubmissionsRef.current.get(clientMessageId);
			if (!item) return;
			const remaining = [...queuedSubmissionsRef.current.entries()].filter(
				([id]) => id !== clientMessageId,
			);
			setSending(true);
			try {
				await rpc<void>({ type: "clear_queue" });
				await remaining.reduce<Promise<void>>(
					(promise, [, queued]) =>
						promise.then(() =>
							rpc<void>({
								type: queued.queueKind,
								message: queued.submission.text,
								images: toPiImageContents(queued.submission.images),
							}),
						),
					Promise.resolve(),
				);
				queuedSubmissionsRef.current.delete(clientMessageId);
				runLocalAction({
					type: "local_user_queue_failed",
					clientMessageId,
				});
				handleComposerChange(item.submission.text);
				setImages(item.submission.images);
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSending(false);
			}
		},
		[
			activeSessionKey,
			client,
			handleComposerChange,
			handleExpiredAuth,
			rpc,
			runLocalAction,
		],
	);

	const handleSendQueuedNow = useCallback(
		async (clientMessageId: string) => {
			if (!client || !activeSessionKey) return;
			const item = queuedSubmissionsRef.current.get(clientMessageId);
			if (!item) return;
			const queued = [...queuedSubmissionsRef.current.entries()];
			const remaining = queued.filter(([id]) => id !== clientMessageId);
			setSending(true);
			try {
				await rpc<void>({ type: "clear_queue" });
				await rpc<void>({ type: "abort" });
				runLocalAction({
					type: "local_turn_abort",
					timestampMs: Date.now(),
				});
				for (const [id] of queued) {
					runLocalAction({
						type: "local_user_queue_failed",
						clientMessageId: id,
					});
				}
				queuedSubmissionsRef.current.clear();

				const now = Date.now();
				runLocalAction({
					type: "local_user_submit",
					clientMessageId,
					text: item.submission.text,
					images: summarizeChatImages(item.submission.images),
					timestampMs: now,
				});
				await client.sendChatCommand(activeSessionKey, {
					type: "prompt",
					message: item.submission.text,
					images: toPiImageContents(item.submission.images),
				});

				for (const [id, pending] of remaining) {
					queuedSubmissionsRef.current.set(id, pending);
					runLocalAction({
						type: "local_user_queue",
						clientMessageId: id,
						text: pending.submission.text,
						images: summarizeChatImages(pending.submission.images),
						queueKind: pending.queueKind,
						timestampMs: now,
					});
				}
				await remaining.reduce<Promise<void>>(
					(promise, [, pending]) =>
						promise.then(() =>
							rpc<void>({
								type: pending.queueKind,
								message: pending.submission.text,
								images: toPiImageContents(pending.submission.images),
							}),
						),
					Promise.resolve(),
				);
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSending(false);
			}
		},
		[activeSessionKey, client, handleExpiredAuth, rpc, runLocalAction],
	);

	const stop = async () => {
		if (!client || !activeSessionKey) return;
		runLocalAction({ type: "local_turn_abort", timestampMs: Date.now() });
		await client
			.sendChatCommand(activeSessionKey, { type: "abort" })
			.catch(() => undefined);
	};

	const changeModel = async (model: PiModel) => {
		if (!hasIdentifiedSession) {
			setDraftModel(model);
			setDraftThinkingLevel(model.defaultThinkingLevel ?? null);
			return;
		}
		try {
			const next = await rpc<PiModel>({
				type: "set_model",
				provider: model.provider,
				modelId: model.id,
			});
			setAgentState((current) =>
				current ? { ...current, model: next } : current,
			);
		} catch (error) {
			setFatalError(error instanceof Error ? error.message : String(error));
		}
	};

	const changeThinking = async (level: PiThinkingLevel) => {
		if (!hasIdentifiedSession) {
			setDraftThinkingLevel(level);
			return;
		}
		try {
			await rpc<void>({ type: "set_thinking_level", level });
			setAgentState((current) =>
				current ? { ...current, thinkingLevel: level } : current,
			);
		} catch (error) {
			setFatalError(error instanceof Error ? error.message : String(error));
		}
	};

	if (pairing) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner className="size-4" /> {t("settings.remoteConnecting")}
				</div>
			</div>
		);
	}

	if (!token) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="w-full max-w-sm rounded-2xl border bg-card p-6 text-center shadow-sm">
					<WifiOff className="mx-auto size-6 text-muted-foreground" />
					<h1 className="mt-4 text-base font-semibold">Pilo Remote</h1>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						{fatalError || t("settings.remotePairRequired")}
					</p>
				</div>
			</div>
		);
	}

	const active = conversation.active !== null;
	const pendingSteering = conversation.pendingUsers.filter(
		(user) => user.queueKind !== "follow_up",
	).length;
	const pendingFollowUps = conversation.pendingUsers.filter(
		(user) => user.queueKind === "follow_up",
	).length;

	const sidebarNode = (
		<AppSidebar
			collapsed={sidebarCollapsed}
			onCollapse={() => setSidebarCollapsed(true)}
			envs={envs}
			projects={sidebarProjects}
			sessions={sidebarSessions}
			selectedProjectId={activeProjectId || null}
			selectedSessionId={identifiedSessionId ?? null}
			onSelectSession={handleSelectSession}
			onNewChat={() => startDraft(activeProjectId || undefined)}
			onNewChatInProject={(projectId) => startDraft(projectId)}
			onRefreshProjectSessions={(projectId) =>
				void refreshProjectSessions(projectId, true)
			}
			refreshingProjectIds={refreshingProjectIds}
			footer={
				<div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
					{connected ? (
						<Wifi className="size-3 shrink-0" />
					) : (
						<WifiOff className="size-3 shrink-0" />
					)}
					<span className="truncate">
						{connected
							? t("settings.remoteConnected")
							: t("settings.remoteReconnecting")}
					</span>
					<button
						type="button"
						aria-label="Reload"
						className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
						onClick={() => void reloadBootstrap()}
					>
						<RefreshCw className="size-3.5" />
					</button>
				</div>
			}
		/>
	);

	return (
		<TooltipProvider>
			<div
				data-remote-webui=""
				className="flex h-dvh overflow-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground"
			>
				{isNarrow ? (
					<RemoteMobileNavigation
						open={mobileNavigationOpen}
						onOpenChange={setMobileNavigationOpen}
						projects={projects}
						sessions={rawSessions}
						activeProjectId={activeProjectId || null}
						selectedSessionId={identifiedSessionId ?? null}
						connected={connected}
						refreshingProjectIds={refreshingProjectIds}
						onSelectSession={handleSelectSession}
						onNewChat={startDraft}
						onRefreshProjectSessions={(projectId) =>
							void refreshProjectSessions(projectId, true)
						}
						onReload={() => void reloadBootstrap()}
					/>
				) : (
					sidebarNode
				)}
				<main className="@container relative flex min-w-0 flex-1 flex-col bg-background">
					<SessionHeader
						session={headerSession ?? undefined}
						sessionState={chatState ?? undefined}
						onExpandSidebar={() => {
							if (isNarrow) setMobileNavigationOpen(true);
							else setSidebarCollapsed(false);
						}}
						sidebarCollapsed={isNarrow ? true : sidebarCollapsed}
						overlay={conversation.messages.length === 0}
					/>

					<div className="relative flex min-h-0 flex-1 flex-col">
						<ChatImageScopeProvider scope={historyImageScope}>
							<ChatConversationViewport
								key={routeKey ?? "remote-draft"}
								active
								visualLive
								showSwitchSkeleton={showSwitchSkeleton}
								sessionId={activeSessionKey ?? "remote-draft"}
								sessionPath={headerSession?.sessionPath}
								messages={visibleMessages}
								onVisibleRangeChange={requestHistoryRange}
								activeAssistantMessageId={activeAssistantMessageId}
								compacting={compacting}
								effectiveLoadState={loadingConversation ? "loading" : "ready"}
								initialScrollTop={initialScrollState.scrollTop}
								initialSticky={initialScrollState.sticky}
								initialVirtualizerCache={
									initialUiState.virtualizerMessageCount ===
									visibleMessages.length
										? initialUiState.virtualizerCache
										: undefined
								}
								onScrollStateChange={persistScrollState}
								onVirtualizerCacheChange={persistVirtualizerCache}
								runtimeScrollRef={scrollRef}
								suppressInterruptedError={active || readOnly}
								onVisualReady={handleVisualReady}
								onRetryHistory={() => setHistoryRetryKey((value) => value + 1)}
							/>
						</ChatImageScopeProvider>
						<div
							className="relative z-20 -mt-4 w-full shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
							style={{ paddingRight: scrollbarWidth }}
						>
							<ConversationColumn className="relative">
								<ChatPendingQueue
									items={conversation.pendingUsers}
									onEdit={(item) => void handleEditQueued(item.clientMessageId)}
									onSendNow={(item) =>
										void handleSendQueuedNow(item.clientMessageId)
									}
								/>
								{recoveryState.status === "idle" &&
								!readOnly &&
								!active &&
								latestTurnInterrupted ? (
									<ChatInterruptedTurnNotice />
								) : null}
								<ChatRuntimeRecoveryNotice
									state={recoveryState}
									onReconnect={reconnectNow}
								/>
								{!hasIdentifiedSession ? (
									<DraftProjectPicker
										projects={projects}
										project={activeProject}
										onSwitchProject={(projectId) => {
											setDraftProjectId(projectId);
											setDraftId(randomId());
											setIdentifiedDraftSessionId(null);
											setComposer(projectDraftCache.get(projectId));
											setImages([]);
											setVisualReadyRouteKey(null);
											autoTitleRequestedRef.current = false;
											setModels([]);
											setDraftModel(null);
											setDraftThinkingLevel(null);
										}}
									/>
								) : null}
								<ChatComposer
									className="remote-chat-composer"
									value={readOnly ? "" : composer}
									onChange={handleComposerChange}
									muted={readOnly}
									placeholder={
										readOnly ? t("chat.externalReadOnly") : undefined
									}
									desktopShortcuts={false}
									historyKey={activeProjectId || null}
									suggestions={composerSuggestions}
									onSuggestionTrigger={handleSuggestionTrigger}
									images={images}
									onImagesChange={setImages}
									onSubmit={(submission) =>
										void sendSubmission(submission, "prompt")
									}
									onSteer={
										active
											? (submission) => void sendSubmission(submission, "steer")
											: undefined
									}
									onFollowUp={
										active
											? (submission) =>
													void sendSubmission(submission, "follow_up")
											: undefined
									}
									disabled={
										readOnly ||
										sending ||
										!activeProjectId ||
										(hasIdentifiedSession && !runtimeReady)
									}
									running={active}
									onStop={() => void stop()}
									pendingSteering={pendingSteering}
									pendingFollowUps={pendingFollowUps}
									statusText={composerStatusText}
									compacting={compacting}
									retrying={retryState?.kind === "agent"}
									contextUsage={chatState}
									models={models}
									selectedModel={selectedModel}
									modelError={fatalError}
									modelDisabled={
										hasIdentifiedSession ? !runtimeReady : !activeProjectId
									}
									onModelMenuOpen={() => {
										if (hasIdentifiedSession) void refreshAgentConfig();
										else if (activeProjectId)
											void loadDraftCatalog(activeProjectId);
									}}
									onModelRefresh={() => {
										if (hasIdentifiedSession) void refreshAgentConfig();
										else if (activeProjectId)
											void loadDraftCatalog(activeProjectId);
									}}
									onModelChange={(model) => {
										if (model) void changeModel(model);
									}}
									thinkingLevels={composerThinkingLevels}
									selectedThinkingLevel={composerSelectedThinkingLevel}
									thinkingDisabled={
										hasIdentifiedSession
											? !runtimeReady || thinkingLevels.length === 0
											: !activeProjectId || composerThinkingLevels.length === 0
									}
									onThinkingMenuOpen={() => {
										if (hasIdentifiedSession) void refreshAgentConfig();
										else if (activeProjectId)
											void loadDraftCatalog(activeProjectId);
									}}
									onThinkingChange={(level) => {
										if (level) void changeThinking(level);
									}}
								/>
							</ConversationColumn>
						</div>
					</div>
				</main>

				<ChatImageLightbox />

				{fatalError ? (
					<div className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-lg rounded-xl border border-destructive/30 bg-background px-3 py-2 text-xs shadow-lg">
						<div className="flex items-start gap-2">
							<p className="min-w-0 flex-1 text-destructive">{fatalError}</p>
							<button type="button" onClick={() => setFatalError(null)}>
								<X className="size-3.5" />
							</button>
						</div>
					</div>
				) : null}
			</div>
		</TooltipProvider>
	);
}
