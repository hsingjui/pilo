import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

import { chatUiStateKey } from "@/components/app/app-chat-state";
import {
	createChatUiStateCache,
	createProjectDraftCache,
} from "@/components/app/chat-ui-state-cache";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import type { ChatImageAttachment } from "@/lib/chat-submission";
import { findReusableChatRuntime } from "@/lib/chat-session-runtime-model";
import { createConversationState } from "@/lib/conversation-reducer";
import type { ConversationState } from "@/lib/conversation-types";
import type { PiAgentState, PiModel } from "@/lib/pi-runtime";
import type { Project } from "@/lib/projects";
import type { PiloClientBootstrap } from "@/lib/pilo-client";
import type { SessionIndexEntry } from "@/lib/sessions";
import { randomId } from "@/lib/utils";
import {
	readRemoteScrollState,
	type RetryState,
	sessionKey,
	sessionLabel,
	writeRemoteScrollState,
} from "./remote-app-model";
import { useRemoteChatActions } from "./use-remote-chat-actions";
import { useRemoteChatAgentConfig } from "./use-remote-chat-agent-config";
import { useRemoteChatAutoTitle } from "./use-remote-chat-auto-title";
import { useRemoteChatCommands } from "./use-remote-chat-commands";
import { useRemoteChatDraftActions } from "./use-remote-chat-draft-actions";
import { useRemoteChatHistory } from "./use-remote-chat-history";
import { useRemoteChatSuggestions } from "./use-remote-chat-suggestions";
import {
	type QueuedSubmission,
	useRemoteChatTransport,
} from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatOptions = {
	client: WebPiloClient | null;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	resyncKey: number;
	setResyncKey: Dispatch<SetStateAction<number>>;
	projects: Project[];
	rawSessions: SessionIndexEntry[];
	chatSessions: PiloClientBootstrap["chatSessions"];
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
	refreshAllSessions: () => Promise<void>;
	scheduleRuntimeActivityRefresh: () => void;
	isExternalOpenTurn: (projectId: string, sessionPath: string) => boolean;
	isNarrow: boolean;
	closeMobileNavigation: () => void;
};

export function useRemoteChat({
	client,
	handleExpiredAuth,
	setFatalError,
	resyncKey,
	setResyncKey,
	projects,
	rawSessions,
	chatSessions,
	refreshProjectSessions,
	refreshAllSessions,
	scheduleRuntimeActivityRefresh,
	isExternalOpenTurn,
	isNarrow,
	closeMobileNavigation,
}: UseRemoteChatOptions) {
	const { t } = useTranslation();

	const [selectedSessionPath, setSelectedSessionPath] = useState<string | null>(
		null,
	);
	const [draftProjectId, setDraftProjectId] = useState("");
	const [draftId, setDraftId] = useState(() => randomId());
	// 草稿态是否为临时会话（noSession）：首条消息发送前不建立持久会话。
	const [draftTemporary, setDraftTemporary] = useState(false);
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
	const activeSessionKeyRef = useRef<string | null>(null);
	const activeTurnRef = useRef(false);
	const queuedSubmissionsRef = useRef(new Map<string, QueuedSubmission>());
	const autoTitleRequestedRef = useRef(false);
	const refreshAgentConfigRef = useRef<(() => Promise<void>) | null>(null);

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
	const resolvedDraftProjectId = useMemo(() => {
		if (
			draftProjectId &&
			projects.some((project) => project.id === draftProjectId)
		) {
			return draftProjectId;
		}
		return projects[0]?.id ?? "";
	}, [draftProjectId, projects]);
	const activeProjectId =
		selectedSession?.projectId ??
		identifiedDraftSession?.projectId ??
		resolvedDraftProjectId;
	const activeProject = useMemo(
		() => projects.find((project) => project.id === activeProjectId) ?? null,
		[projects, activeProjectId],
	);
	const hasIdentifiedSession = Boolean(
		selectedSession || identifiedDraftSessionId,
	);
	const identifiedSessionId =
		selectedSession?.piSessionId ?? identifiedDraftSessionId;
	const reusableRuntime = selectedSession
		? findReusableChatRuntime(
				chatSessions,
				selectedSession.projectId,
				selectedSession.sessionPath,
			)
		: null;
	const activeSessionKey = activeProjectId
		? selectedSession
			? (runtimeSessionKeys.get(selectedSession.piSessionId) ??
				reusableRuntime?.sessionKey ??
				sessionKey(activeProjectId, selectedSession.piSessionId))
			: sessionKey(activeProjectId, draftId)
		: null;
	const routeSessionId =
		selectedSession?.piSessionId ?? identifiedDraftSessionId ?? draftId;

	const transport = useRemoteChatTransport({
		client,
		handleExpiredAuth,
		setFatalError,
		setResyncKey,
		setConversation,
		scheduleRuntimeActivityRefresh,
		refreshAllSessions,
		refreshAgentConfigRef,
		activeSessionKeyRef,
		queuedSubmissionsRef,
		setCompacting,
		setRetryState,
	});
	const { rpc, rpcForSession, handleSocketMessage, abortPiRetry } = transport;
	const agentConfig = useRemoteChatAgentConfig({
		client,
		rpc,
		activeProjectId,
		draftId,
		selectedSession,
	});
	const {
		agentState,
		setAgentState,
		chatState,
		setChatState,
		models,
		setModels,
		modelLoading,
		thinkingLevels,
		setThinkingLevels,
		draftModel,
		setDraftModel,
		draftThinkingLevel,
		setDraftThinkingLevel,
		refreshAgentConfig,
		loadDraftCatalog,
	} = agentConfig;
	const routeUiKey = activeProjectId
		? chatUiStateKey(activeProjectId, routeSessionId)
		: "remote-draft";
	const initialUiState = useMemo(
		() => chatUiStateCache.get(routeUiKey),
		[chatUiStateCache, routeUiKey],
	);

	const headerSession = useMemo<ChatSession | null>(() => {
		if (!activeProject) return null;
		// 临时会话不写盘、不进入会话索引，因此没有可识别的 Pi sessionId；
		// 直接以草稿身份展示，并在顶栏呈现临时标识。
		if (draftTemporary && !selectedSession && !identifiedDraftSession) {
			return {
				id: draftId,
				title: t("app.temporaryChat"),
				projectRecord: activeProject,
				temporary: true,
				sessionPath: agentState?.sessionFile,
			};
		}
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
		draftId,
		draftTemporary,
		identifiedDraftSession,
		identifiedDraftSessionId,
		selectedSession,
		t,
	]);

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
		refreshAgentConfigRef.current = refreshAgentConfig;
	}, [refreshAgentConfig]);
	useEffect(() => {
		activeSessionKeyRef.current = activeSessionKey;
	}, [activeSessionKey]);
	useEffect(() => {
		activeTurnRef.current = conversation.active !== null;
	}, [conversation.active]);

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
		(cache: import("virtua").CacheSnapshot, messageCount: number) => {
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

	const history = useRemoteChatHistory({
		client,
		activeProjectId,
		activeSessionKey,
		selectedSession,
		resyncKey,
		isExternalOpenTurn,
		refreshAgentConfig,
		handleExpiredAuth,
		setFatalError,
		setConversation,
		setRuntimeReady,
		setReadOnly,
	});
	const {
		historyPrefix,
		loadingConversation,
		requestHistoryRange,
		retryHistory,
	} = history;
	const visibleMessages = useMemo(
		() =>
			historyPrefix.length > 0
				? [...historyPrefix, ...conversation.messages]
				: conversation.messages,
		[conversation.messages, historyPrefix],
	);

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
						fingerprint: history.fingerprint,
						readImage: client.readHistoryImage.bind(client),
					}
				: null,
		[activeProjectId, client, history.fingerprint, selectedSession],
	);

	const {
		startDraft,
		toggleTemporaryChat,
		switchDraftProject,
		handleSelectSession,
		identifyDraftSession,
	} = useRemoteChatDraftActions({
		activeProjectId,
		draftId,
		draftTemporary,
		selectedSession,
		identifiedDraftSessionId,
		selectedSessionPath,
		rawSessions,
		isNarrow,
		closeMobileNavigation,
		chatUiStateCache,
		projectDraftCache,
		queuedSubmissionsRef,
		autoTitleRequestedRef,
		refreshProjectSessions,
		setSelectedSessionPath,
		setIdentifiedDraftSessionId,
		setDraftTemporary,
		setDraftId,
		setConversation,
		setRuntimeReady,
		setReadOnly,
		setAgentState,
		setChatState,
		setModels,
		setThinkingLevels,
		setDraftModel,
		setDraftThinkingLevel,
		setComposer,
		setImages,
		setVisualReadyRouteKey,
		setDraftProjectId,
		setRuntimeSessionKeys,
	});

	// A refresh can drop the selected session from rawSessions (external delete or
	// index refresh). Route that through startDraft so selection and runtime state
	// reset on the single canonical path instead of leaving a stale conversation.
	useEffect(() => {
		if (!selectedSessionPath || selectedSession) return;
		startDraft();
	}, [selectedSession, selectedSessionPath, startDraft]);

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
			noSession: draftTemporary,
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
		draftTemporary,
		identifiedDraftSessionId,
		identifyDraftSession,
		refreshAgentConfig,
		rpc,
		runtimeReady,
		setAgentState,
		selectedSession,
	]);

	const suggestions = useRemoteChatSuggestions({
		client,
		activeProjectId,
		readOnly,
		ensureDraftRuntime,
		rpc,
	});
	const {
		composerSuggestions,
		handleSuggestionTrigger,
		loadExtensionCommandNames,
	} = suggestions;

	const requestAutoTitle = useRemoteChatAutoTitle({
		client,
		activeProjectId,
		activeSessionKey,
		selectedSession,
		draftTemporary,
		autoTitleRequestedRef,
		activeSessionKeyRef,
		rpcForSession,
		refreshProjectSessions,
		handleExpiredAuth,
		setAgentState,
		setChatState,
	});

	const composerThinkingLevelsForModel = selectedSession
		? thinkingLevels
		: (draftModel?.thinkingLevels ?? []);
	const composerSelectedThinkingLevel = selectedSession
		? (agentState?.thinkingLevel ?? null)
		: draftThinkingLevel;

	const { tryHandleComposerCommand } = useRemoteChatCommands({
		client,
		activeProjectId,
		activeSessionKey,
		clearComposer,
		ensureDraftRuntime,
		handleExpiredAuth,
		loadExtensionCommandNames,
		rpc,
		startDraft,
		setFatalError,
	});

	const {
		sending,
		sendSubmission,
		handleEditQueued,
		handleSendQueuedNow,
		stop,
		changeModel,
		changeThinking,
	} = useRemoteChatActions({
		client,
		activeSessionKey,
		readOnly,
		hasSelectedSession: Boolean(selectedSession),
		hasIdentifiedSession,
		autoTitleRequestedRef,
		queuedSubmissionsRef,
		ensureDraftRuntime,
		tryHandleComposerCommand,
		requestAutoTitle,
		clearComposer,
		handleComposerChange,
		setImages,
		handleExpiredAuth,
		setFatalError,
		setConversation,
		setAgentState,
		setDraftModel,
		setDraftThinkingLevel,
		rpc,
	});

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

	return {
		// route / selection
		activeProjectId,
		activeProject,
		activeSessionKey,
		routeKey,
		routeUiKey,
		hasIdentifiedSession,
		identifiedSessionId,
		selectedSession,
		selectedSessionPath,
		draftTemporary,
		thinkingLevels,
		// conversation
		conversation,
		visibleMessages,
		activeAssistantMessageId,
		latestTurnInterrupted,
		historyImageScope,
		// view state
		headerSession,
		chatState,
		composerStatusText,
		initialUiState,
		initialScrollState,
		persistScrollState,
		persistVirtualizerCache,
		handleVisualReady,
		showSwitchSkeleton,
		requestHistoryRange,
		// composer / config
		composer,
		images,
		setImages,
		handleComposerChange,
		composerSuggestions,
		handleSuggestionTrigger,
		selectedModel,
		composerThinkingLevels: composerThinkingLevelsForModel,
		composerSelectedThinkingLevel,
		models,
		modelLoading,
		sending,
		retryState,
		compacting,
		readOnly,
		runtimeReady,
		loadingConversation,
		// actions
		startDraft,
		toggleTemporaryChat,
		switchDraftProject,
		handleSelectSession,
		retryHistory,
		sendSubmission,
		handleEditQueued,
		handleSendQueuedNow,
		stop,
		changeModel,
		changeThinking,
		refreshAgentConfig,
		loadDraftCatalog,
		abortPiRetry,
		handleSocketMessage,
	};
}
