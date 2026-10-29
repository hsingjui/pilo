import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

import { chatUiStateKey } from "@/components/app/app-chat-state";
import {
	createChatUiStateCache,
	createProjectDraftCache,
} from "@/components/app/chat-ui-state-cache";
import { createChatConversationStore } from "@/components/chat/chat-conversation-store";
import { INITIAL_HISTORY_MESSAGE_COUNT } from "@/components/chat/chat-conversation-model";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import type { PiExtensionDialogRequest } from "@/components/chat/use-pi-session-features";
import type { ChatImageAttachment } from "@/lib/chat/chat-submission";
import {
	chatRuntimeHasOpenTurn,
	findReusableChatRuntime,
} from "@/lib/chat/chat-session-runtime-model";
import { createConversationState } from "@/lib/chat/conversation-reducer";
import type { ConversationState } from "@/lib/chat/conversation-types";
import type { PiAgentState, PiModel } from "@/lib/api/pi-runtime";
import type { Project } from "@/lib/api/projects";
import type { PiloClientBootstrap } from "@/lib/api/pilo-client";
import {
	getProjectScopeModels,
	getProjectScopeDefaultModel,
	getPiQuickCycleThinkingLevel,
	isPiScopeCatalogResolved,
} from "@/lib/pi-model-selection";
import { useProjectModelScope } from "@/lib/use-project-model-scope";
import type { SessionIndexEntry } from "@/lib/api/sessions";
import { randomId } from "@/lib/utils";
import {
	readRemoteProjectId,
	readRemoteScrollState,
	type RetryState,
	sessionKey,
	sessionLabel,
	writeRemoteProjectId,
	writeRemoteScrollState,
} from "./remote-app-model";
import {
	type PendingProjectMcpPrompt,
	useRemoteChatActions,
} from "./use-remote-chat-actions";
import { useRemoteChatAgentConfig } from "./use-remote-chat-agent-config";
import { useRemoteChatAutoTitle } from "./use-remote-chat-auto-title";
import { useRemoteChatCommands } from "./use-remote-chat-commands";
import { useRemoteChatDraftActions } from "./use-remote-chat-draft-actions";
import { useRemoteChatHistory } from "./use-remote-chat-history";
import { useRemoteChatFork } from "./use-remote-chat-fork";
import { useRemoteExtensionUi } from "./use-remote-extension-ui";
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
	snapshotRefreshKey: number;
	setResyncKey: Dispatch<SetStateAction<number>>;
	projects: Project[];
	rawSessions: SessionIndexEntry[];
	chatSessions: PiloClientBootstrap["chatSessions"];
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
	refreshAllSessions: () => Promise<void>;
	scheduleRuntimeActivityRefresh: (projectId?: string) => void;
	isExternalOpenTurn: (projectId: string, sessionPath: string) => boolean;
	isNarrow: boolean;
	closeMobileNavigation: () => void;
};

export function useRemoteChat({
	client,
	handleExpiredAuth,
	setFatalError,
	resyncKey,
	snapshotRefreshKey,
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
	const [draftProjectId, setDraftProjectId] = useState(readRemoteProjectId);
	const [draftId, setDraftId] = useState(() => randomId());
	// 草稿态是否为临时会话（noSession）：首条消息发送前不建立持久会话。
	const [draftTemporary, setDraftTemporary] = useState(false);
	const [identifiedDraftSessionId, setIdentifiedDraftSessionId] = useState<
		string | null
	>(null);
	const [initialConversation] = useState(createConversationState);
	const [conversationStore] = useState(() => {
		const store = createChatConversationStore();
		store.setSnapshot(initialConversation);
		return store;
	});
	const conversationUiRef = useRef({
		active: false,
		messageCount: 0,
		pendingUsers: initialConversation.pendingUsers,
		latestTurnInterrupted: false,
	});
	const getConversationUi = useCallback(() => conversationUiRef.current, []);
	const conversationUi = useSyncExternalStore(
		conversationStore.subscribe,
		getConversationUi,
		getConversationUi,
	);
	const setConversation = useCallback<
		Dispatch<SetStateAction<ConversationState>>
	>(
		(update) => {
			const current = conversationStore.getSnapshot() ?? initialConversation;
			const next = typeof update === "function" ? update(current) : update;
			let interrupted = false;
			for (let index = next.messages.length - 1; index >= 0; index -= 1) {
				const message = next.messages[index];
				if (message.role === "assistant" && !message.historyPlaceholder) {
					interrupted = message.completion === "interrupted";
					break;
				}
			}
			const previous = conversationUiRef.current;
			if (
				previous.active !== (next.active !== null) ||
				previous.messageCount !== next.messages.length ||
				previous.pendingUsers !== next.pendingUsers ||
				previous.latestTurnInterrupted !== interrupted
			) {
				conversationUiRef.current = {
					active: next.active !== null,
					messageCount: next.messages.length,
					pendingUsers: next.pendingUsers,
					latestTurnInterrupted: interrupted,
				};
			}
			conversationStore.setSnapshot(next);
		},
		[conversationStore, initialConversation],
	);
	const [runtimeReady, setRuntimeReady] = useState(false);
	const [externalReadOnly, setReadOnly] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [retryState, setRetryState] = useState<RetryState | null>(null);
	const [composer, setComposer] = useState("");
	const [images, setImages] = useState<ChatImageAttachment[]>([]);
	const pendingForkSessionIdRef = useRef<{
		sessionId: string;
		projectId: string;
	} | null>(null);
	const [chatUiStateCache] = useState(createChatUiStateCache);
	const [projectDraftCache] = useState(createProjectDraftCache);
	const [visualReadyRouteKey, setVisualReadyRouteKey] = useState<string | null>(
		null,
	);
	const [runtimeSessionKeys, setRuntimeSessionKeys] = useState<
		ReadonlyMap<string, string>
	>(() => new Map());
	const activeSessionKeyRef = useRef<string | null>(null);
	const queuedSubmissionsRef = useRef(new Map<string, QueuedSubmission>());
	const autoTitleRequestedRef = useRef(false);
	const pendingProjectMcpPromptsRef = useRef(
		new Map<string, PendingProjectMcpPrompt>(),
	);
	const projectMcpApprovalRequestedRef = useRef(new Set<string>());
	const projectMcpResumeRef = useRef<
		((sessionKey: string) => Promise<void>) | null
	>(null);
	const projectMcpFailRef = useRef<
		((sessionKey: string, error: unknown) => void) | null
	>(null);
	const projectMcpCancelRef = useRef<((sessionKey: string) => void) | null>(
		null,
	);
	const refreshAgentConfigRef = useRef<(() => Promise<void>) | null>(null);
	const handleExtensionRequestRef = useRef<
		((event: PiExtensionDialogRequest) => void) | null
	>(null);

	const selectedSession = useMemo(
		() =>
			rawSessions.find(
				(session) =>
					session.projectId === draftProjectId &&
					session.sessionPath === selectedSessionPath,
			) ?? null,
		[draftProjectId, rawSessions, selectedSessionPath],
	);
	const identifiedDraftSession = useMemo(
		() =>
			rawSessions.find(
				(session) =>
					session.projectId === draftProjectId &&
					session.piSessionId === identifiedDraftSessionId,
			) ?? null,
		[draftProjectId, identifiedDraftSessionId, rawSessions],
	);
	const resolvedDraftProjectId = useMemo(() => {
		if (
			draftProjectId &&
			projects.some(
				(project) =>
					project.id === draftProjectId && project.connection.shownInHome,
			)
		) {
			return draftProjectId;
		}
		return projects.find((project) => project.connection.shownInHome)?.id ?? "";
	}, [draftProjectId, projects]);
	useEffect(() => {
		// Bootstrap validates the restored id; an empty list must not erase it.
		if (resolvedDraftProjectId) writeRemoteProjectId(resolvedDraftProjectId);
	}, [resolvedDraftProjectId]);
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
	const runtimeTurnOpen = chatRuntimeHasOpenTurn(reusableRuntime);
	const activeSessionKey = activeProjectId
		? selectedSession
			? (runtimeSessionKeys.get(
					sessionKey(activeProjectId, selectedSession.piSessionId),
				) ??
				reusableRuntime?.sessionKey ??
				sessionKey(activeProjectId, selectedSession.piSessionId))
			: sessionKey(activeProjectId, draftId)
		: null;
	const routeSessionId =
		selectedSession?.piSessionId ?? identifiedDraftSessionId ?? draftId;

	const scopeConfig = useProjectModelScope(
		client,
		activeProjectId,
		resyncKey + snapshotRefreshKey,
	);
	const transport = useRemoteChatTransport({
		client,
		handleModelScopeEvent: scopeConfig.handleEvent,
		handleExpiredAuth,
		setFatalError,
		setResyncKey,
		setConversation,
		scheduleRuntimeActivityRefresh,
		refreshAllSessions,
		refreshAgentConfigRef,
		handleExtensionRequestRef,
		activeSessionKeyRef,
		projectMcpApprovalRequestedRef,
		queuedSubmissionsRef,
		setCompacting,
		setRetryState,
	});
	const { rpc, rpcForSession, handleSocketMessage, abortPiRetry } = transport;
	const readSessionState = useCallback(
		(targetSessionKey: string) =>
			rpcForSession<PiAgentState>(targetSessionKey, { type: "get_state" }),
		[rpcForSession],
	);
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
		modelsLoaded,
		modelError,
		catalog,
		thinkingLevels,
		setThinkingLevels,
		draftModel,
		setDraftModel,
		draftThinkingLevel,
		setDraftThinkingLevel,
		refreshAgentConfig,
		loadDraftCatalog,
		historyModel,
		historyThinkingLevel,
		applyHistoryMetadata,
		sessionHeaderMissing,
	} = agentConfig;
	const readOnly = externalReadOnly || sessionHeaderMissing;
	const hasScopeDefault = Boolean(
		scopeConfig.scope?.models?.some((entry) => entry.isDefault),
	);
	const projectScopeDefaultModel = useMemo(
		() =>
			getProjectScopeDefaultModel(
				catalog?.projectId === activeProjectId ? catalog.models : [],
				scopeConfig.scope,
			),
		[activeProjectId, catalog, scopeConfig.scope],
	);
	const initialDraftModel = draftModel ?? projectScopeDefaultModel;
	const initialDraftThinkingLevel =
		draftThinkingLevel ??
		(draftModel
			? (draftModel.defaultThinkingLevel ?? null)
			: projectScopeDefaultModel
				? getPiQuickCycleThinkingLevel(projectScopeDefaultModel)
				: null);
	const needsDraftDefault =
		!hasIdentifiedSession && !runtimeReady && !draftModel;
	const draftConfigError = needsDraftDefault
		? (scopeConfig.error ?? (hasScopeDefault ? modelError : null))
		: null;
	const draftConfigPending =
		needsDraftDefault &&
		(scopeConfig.loading ||
			Boolean(draftConfigError) ||
			(hasScopeDefault && !modelsLoaded));
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
		runtimeTurnOpen,
		refreshAgentConfig,
		onHistoryMetadata: applyHistoryMetadata,
		getConversationState: conversationStore.getSnapshot,
		handleExpiredAuth,
		setFatalError,
		setConversation,
		setRuntimeReady,
		setReadOnly,
	});
	const {
		historyPrefix,
		loadingConversation,
		historyReady,
		historyIndexStale,
		requestHistoryRange,
		retryHistory,
	} = history;
	const getVisibleMessages = useCallback(
		() => [
			...historyPrefix,
			...(conversationStore.getSnapshot() ?? initialConversation).messages,
		],
		[conversationStore, historyPrefix, initialConversation],
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
	const approveProjectMcpServer = useCallback(
		async (serverName: string) => {
			if (!client || !activeProjectId || !activeSessionKey) {
				throw new Error("Choose a project first");
			}
			await client.approveProjectMcpServer(activeProjectId, serverName);
			const input = {
				projectId: activeProjectId,
				sessionKey: activeSessionKey,
				sessionPath: selectedSession?.sessionPath,
				noSession: draftTemporary,
			};
			const targetSessionKey = activeSessionKey;
			await client.startChat(input).catch(() => undefined);
			await client.startChat(input).finally(async () => {
				if (
					draftTemporary &&
					activeSessionKeyRef.current !== targetSessionKey
				) {
					await client
						.stopChat(targetSessionKey, "temporary_approval_abandoned")
						.catch((error) => {
							console.warn(
								"Failed to stop abandoned temporary approval",
								error,
							);
						});
				}
			});
			if (activeSessionKeyRef.current === targetSessionKey)
				setRuntimeReady(true);
		},
		[
			activeProjectId,
			activeSessionKey,
			client,
			draftTemporary,
			selectedSession?.sessionPath,
		],
	);
	const resumeProjectMcpPrompt = useCallback(
		async (targetSessionKey: string) => {
			await projectMcpResumeRef.current?.(targetSessionKey);
		},
		[],
	);
	const failProjectMcpPrompt = useCallback(
		(targetSessionKey: string, error: unknown) => {
			projectMcpFailRef.current?.(targetSessionKey, error);
		},
		[],
	);
	const cancelProjectMcpPrompt = useCallback((targetSessionKey: string) => {
		projectMcpCancelRef.current?.(targetSessionKey);
	}, []);
	const extensionUi = useRemoteExtensionUi({
		rpc,
		activeSessionKey,
		onSetEditorText: handleComposerChange,
		onApproveProjectMcpServer: approveProjectMcpServer,
		projectMcpApprovalRequestedRef,
		onProjectMcpApproved: resumeProjectMcpPrompt,
		onProjectMcpApprovalFailed: failProjectMcpPrompt,
		onProjectMcpDeclined: cancelProjectMcpPrompt,
	});
	useEffect(() => {
		handleExtensionRequestRef.current = extensionUi.handleExtensionRequest;
	}, [extensionUi.handleExtensionRequest]);
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

	const projectImageScope = useMemo(
		() =>
			client && activeProjectId
				? {
						projectId: activeProjectId,
						projectPath: activeProject?.path,
						sessionKey: routeKey ?? "remote-draft",
						readImage: client.readProjectImage.bind(client),
					}
				: null,
		[activeProjectId, activeProject?.path, client, routeKey],
	);

	const releaseTemporaryRuntime = useCallback(() => {
		if (!draftTemporary || !activeSessionKey || !client) return;
		void client
			.stopChat(activeSessionKey, "temporary_chat_left")
			.catch((error) => {
				console.warn("Failed to stop abandoned temporary chat", error);
			});
	}, [activeSessionKey, client, draftTemporary]);

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
		hasChatSession:
			hasIdentifiedSession || runtimeReady || conversationUi.messageCount > 0,
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
		releaseTemporaryRuntime,
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
		if (sessionHeaderMissing) throw new Error(t("chat.sessionHeaderMissing"));
		if (draftConfigPending)
			throw new Error(draftConfigError ?? t("common.loading"));
		if (!client || !activeProjectId || !activeSessionKey)
			throw new Error("Choose a project first");
		const targetSessionKey = activeSessionKey;
		const isActiveSession = () =>
			activeSessionKeyRef.current === targetSessionKey;
		const targetRpc = <T>(command: Record<string, unknown>) =>
			rpcForSession<T>(targetSessionKey, command);
		const runtime = runtimeReady
			? await client.chatState(targetSessionKey)
			: null;
		if (runtime?.snapshot.state === "running" && runtime.initialized) {
			if (draftTemporary && !isActiveSession()) {
				throw new Error("temporary session is closing");
			}
			if (!agentState || (!selectedSession && !identifiedDraftSessionId)) {
				const state = await targetRpc<PiAgentState>({ type: "get_state" });
				if (isActiveSession()) {
					setAgentState(state);
					if (!selectedSession) identifyDraftSession(state);
				}
			}
			return;
		}
		await client
			.startChat({
				projectId: activeProjectId,
				sessionKey: targetSessionKey,
				sessionPath:
					selectedSession?.sessionPath ??
					(identifiedDraftSessionId ? agentState?.sessionFile : undefined),
				noSession: draftTemporary,
			})
			.catch((error: unknown) => {
				if (
					isActiveSession() &&
					error instanceof Error &&
					error.message.includes("read-only observer mode")
				) {
					setReadOnly(true);
				}
				throw error;
			})
			.finally(async () => {
				// Leaving while startup is pending can precede creation of the runtime.
				if (draftTemporary && !isActiveSession()) {
					await client
						.stopChat(targetSessionKey, "temporary_start_abandoned")
						.catch((error) => {
							console.warn("Failed to stop abandoned temporary startup", error);
						});
				}
			});
		if (draftTemporary && !isActiveSession()) {
			throw new Error("temporary session is closing");
		}
		// Carry the draft run-config onto the freshly started session, matching the
		// Desktop `prepareRuntimeConfiguration` step for new chats. Selected sessions
		// keep whatever model Pi already restored.
		const isNewDraft = !selectedSession && !identifiedDraftSessionId;
		if (isNewDraft && initialDraftModel) {
			await targetRpc<PiModel>({
				type: "set_model",
				provider: initialDraftModel.provider,
				modelId: initialDraftModel.id,
			});
		}
		if (isNewDraft && initialDraftThinkingLevel) {
			await targetRpc<void>({
				type: "set_thinking_level",
				level: initialDraftThinkingLevel,
			});
		}
		// Hydrate real state before callers mutate model/thinking settings.
		const state = await targetRpc<PiAgentState>({ type: "get_state" });
		if (isActiveSession()) {
			setRuntimeReady(true);
			setAgentState(state);
			if (!selectedSession) identifyDraftSession(state);
		}
		window.setTimeout(() => {
			if (isActiveSession()) void refreshAgentConfig();
		}, 50);
	}, [
		activeProjectId,
		activeSessionKey,
		agentState,
		client,
		draftConfigError,
		draftConfigPending,
		initialDraftModel,
		initialDraftThinkingLevel,
		draftTemporary,
		identifiedDraftSessionId,
		identifyDraftSession,
		refreshAgentConfig,
		rpcForSession,
		runtimeReady,
		setAgentState,
		selectedSession,
		sessionHeaderMissing,
		t,
	]);

	const refreshActiveAgentConfig = useCallback(
		async (liveRuntime = true) => {
			const targetSessionKey = activeSessionKey;
			try {
				if (liveRuntime && !readOnly) await ensureDraftRuntime();
				if (activeSessionKeyRef.current !== targetSessionKey) return;
				await refreshAgentConfig(liveRuntime);
			} catch (error) {
				if (
					activeSessionKeyRef.current === targetSessionKey &&
					!handleExpiredAuth(error)
				) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			}
		},
		[
			activeSessionKey,
			ensureDraftRuntime,
			handleExpiredAuth,
			readOnly,
			refreshAgentConfig,
			setFatalError,
		],
	);

	const suggestions = useRemoteChatSuggestions({
		client,
		activeProjectId,
		commands:
			catalog?.projectId === activeProjectId
				? (catalog.commands ?? null)
				: null,
		readOnly,
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

	const draftConfigUnresolved =
		needsDraftDefault &&
		(!scopeConfig.scope || (hasScopeDefault && !modelsLoaded));
	const draftDisplayModel = draftConfigUnresolved
		? null
		: (initialDraftModel ?? catalog?.defaultModel ?? null);
	const composerThinkingLevelsForModel =
		hasIdentifiedSession || runtimeReady
			? thinkingLevels
			: (draftDisplayModel?.thinkingLevels ?? []);
	const composerSelectedThinkingLevel =
		hasIdentifiedSession || runtimeReady
			? (agentState?.thinkingLevel ?? historyThinkingLevel)
			: draftConfigUnresolved
				? null
				: initialDraftModel
					? initialDraftThinkingLevel
					: (draftThinkingLevel ?? catalog?.defaultThinkingLevel ?? null);

	const { tryHandleComposerCommand } = useRemoteChatCommands({
		client,
		activeProjectId,
		activeSessionKey,
		activeSessionKeyRef,
		clearComposer,
		ensureDraftRuntime,
		handleExpiredAuth,
		loadExtensionCommandNames,
		rpcForSession,
		startDraft,
		setFatalError,
	});

	const {
		sending,
		sendSubmission,
		handleEditQueued,
		handleSendQueuedNow,
		handleSendNow,
		stop,
		changeModel,
		changeThinking,
		resumeProjectMcpPrompt: resumeProjectMcpPromptAction,
		failProjectMcpPrompt: failProjectMcpPromptAction,
		cancelProjectMcpPrompt: cancelProjectMcpPromptAction,
	} = useRemoteChatActions({
		client,
		activeSessionKey,
		activeSessionKeyRef,
		routeUiKey,
		composer,
		readOnly,
		hasSelectedSession: Boolean(selectedSession),
		hasIdentifiedSession,
		autoTitleRequestedRef,
		pendingProjectMcpPromptsRef,
		projectMcpApprovalRequestedRef,
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
		rpcForSession,
	});

	useEffect(() => {
		projectMcpResumeRef.current = resumeProjectMcpPromptAction;
		projectMcpFailRef.current = failProjectMcpPromptAction;
		projectMcpCancelRef.current = cancelProjectMcpPromptAction;
		return () => {
			if (projectMcpResumeRef.current === resumeProjectMcpPromptAction)
				projectMcpResumeRef.current = null;
			if (projectMcpFailRef.current === failProjectMcpPromptAction)
				projectMcpFailRef.current = null;
			if (projectMcpCancelRef.current === cancelProjectMcpPromptAction)
				projectMcpCancelRef.current = null;
		};
	}, [
		cancelProjectMcpPromptAction,
		failProjectMcpPromptAction,
		resumeProjectMcpPromptAction,
	]);

	const refreshSessionDisabled =
		conversationUi.active ||
		runtimeTurnOpen ||
		compacting ||
		sending ||
		Boolean(retryState) ||
		externalReadOnly ||
		loadingConversation ||
		Boolean(extensionUi.extensionDialog);
	const refreshSession = useCallback(
		async (sessionId: string, projectId: string) => {
			if (!client) return;
			const target = rawSessions.find(
				(entry) =>
					entry.projectId === projectId && entry.piSessionId === sessionId,
			);
			if (!target) throw new Error(t("chat.sessionPathUnavailable"));
			const isCurrent =
				activeProjectId === projectId && identifiedSessionId === sessionId;
			const targetKey = isCurrent ? activeSessionKey : null;
			if (isCurrent && refreshSessionDisabled) {
				throw new Error(t("chat.refreshSessionUnavailable"));
			}
			try {
				const [bootstrap, external] = await Promise.all([
					client.bootstrap(),
					client.externalActivity(projectId),
				]);
				const runtime = findReusableChatRuntime(
					bootstrap.chatSessions,
					projectId,
					target.sessionPath,
				);
				if (
					chatRuntimeHasOpenTurn(runtime) ||
					runtime?.compacting ||
					external.some(
						(entry) => entry.path === target.sessionPath && entry.turnOpen,
					)
				) {
					throw new Error(t("chat.refreshSessionRunning"));
				}
				if (runtime?.initialized && runtime.snapshot.state === "running") {
					const state = await readSessionState(runtime.sessionKey);
					if (state.isStreaming || state.isCompacting) {
						throw new Error(t("chat.refreshSessionRunning"));
					}
				}
				if (targetKey && activeSessionKeyRef.current === targetKey) {
					if (conversationStore.getSnapshot()?.active) {
						throw new Error(t("chat.refreshSessionRunning"));
					}
					setFatalError(null);
					if (!selectedSession) setSelectedSessionPath(target.sessionPath);
					retryHistory();
				} else {
					await client.loadHistory(projectId, target.sessionPath, {
						messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
						includeMessageIndex: true,
					});
				}
				await refreshProjectSessions(projectId);
			} catch (error) {
				if (!handleExpiredAuth(error)) throw error;
			}
		},
		[
			activeProjectId,
			activeSessionKey,
			client,
			conversationStore,
			handleExpiredAuth,
			identifiedSessionId,
			rawSessions,
			readSessionState,
			refreshProjectSessions,
			refreshSessionDisabled,
			retryHistory,
			selectedSession,
			setFatalError,
			t,
		],
	);

	const fork = useRemoteChatFork({
		client,
		activeProjectId,
		activeSessionKey,
		selectedSession,
		getMessages: getVisibleMessages,
		busy:
			conversationUi.active ||
			loadingConversation ||
			compacting ||
			sending ||
			readOnly,
		ensureDraftRuntime,
		rpcForSession,
		refreshProjectSessions,
		onForkSessionCreated: (sessionId, projectId) => {
			pendingForkSessionIdRef.current = { sessionId, projectId };
		},
	});

	useEffect(() => {
		const pendingForkSessionId = pendingForkSessionIdRef.current;
		if (!pendingForkSessionId) return;
		if (
			!rawSessions.some(
				(session) =>
					session.projectId === pendingForkSessionId.projectId &&
					session.piSessionId === pendingForkSessionId.sessionId,
			)
		) {
			return;
		}
		pendingForkSessionIdRef.current = null;
		handleSelectSession(
			pendingForkSessionId.sessionId,
			pendingForkSessionId.projectId,
		);
	}, [handleSelectSession, rawSessions]);

	const selectedModel = useMemo(() => {
		if (!hasIdentifiedSession && !runtimeReady) return draftDisplayModel;
		const current = agentState?.model ?? historyModel;
		if (!current) return null;
		return (
			models.find(
				(model) =>
					model.provider === current.provider && model.id === current.id,
			) ?? current
		);
	}, [
		agentState?.model,
		draftDisplayModel,
		hasIdentifiedSession,
		historyModel,
		models,
		runtimeReady,
	]);

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
		conversationStore,
		conversationUi,
		historyPrefix,
		latestTurnInterrupted: conversationUi.latestTurnInterrupted,
		historyImageScope,
		projectImageScope,
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
		draftConfigPending,
		draftConfigError,
		models,
		modelLoading:
			modelLoading || (draftConfigUnresolved && scopeConfig.loading),
		modelError,
		modelScope: {
			...scopeConfig,
			availableModels: models,
			models: getProjectScopeModels(
				models,
				scopeConfig.scope,
				catalog?.models ?? [],
			),
			catalogReady:
				scopeConfig.scope?.models != null
					? modelsLoaded
					: catalog?.projectId === activeProjectId &&
						isPiScopeCatalogResolved(catalog.models),
		},
		sending,
		retryState,
		compacting,
		readOnly,
		sessionHeaderMissing,
		runtimeReady,
		loadingConversation,
		historyReady,
		historyIndexStale,
		forkingMessageId: fork.forkingMessageId,
		forkDisabled:
			conversationUi.active ||
			loadingConversation ||
			compacting ||
			sending ||
			readOnly,
		extensionDialog: extensionUi.extensionDialog,
		extensionNotifications: extensionUi.extensionNotifications,
		// actions
		startDraft,
		toggleTemporaryChat,
		switchDraftProject,
		handleSelectSession,
		retryHistory,
		refreshSession,
		sendSubmission,
		handleEditQueued,
		handleSendQueuedNow,
		handleSendNow,
		stop,
		changeModel,
		changeThinking,
		refreshAgentConfig: refreshActiveAgentConfig,
		loadDraftCatalog,
		abortPiRetry,
		handleForkAssistant: fork.handleForkAssistant,
		respondToExtensionDialog: extensionUi.respondToExtensionDialog,
		dismissExtensionNotification: extensionUi.dismissExtensionNotification,
		handleSocketMessage,
		readSessionState,
	};
}
