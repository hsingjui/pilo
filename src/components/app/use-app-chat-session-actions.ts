import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
	chatUiStateKey,
	identifyOpenedChat,
	touchOpenedChat,
	trimOpenedChats,
	type OpenChat,
} from "@/components/app/app-chat-state";
import type { ChatUiStateCache } from "@/components/app/chat-ui-state-cache";
import type { BusyChatControllersRef } from "@/components/app/use-opened-chat-controllers";
import type { ChatSession } from "@/components/chat/chat-page";
import { userErrorMessage } from "@/lib/app-error";
import {
	listChatSessionRuntimeStates,
	stopChatSession,
} from "@/lib/api/chat-session-client";
import { requestPiRpc, type PiAgentState } from "@/lib/api/pi-runtime";
import {
	chatRuntimeHasOpenTurn,
	findReusableChatRuntime,
} from "@/lib/chat/chat-session-runtime-model";
import { INITIAL_HISTORY_MESSAGE_COUNT } from "@/components/chat/chat-conversation-model";
import {
	getExternalSessionActivity,
	loadSessionHistoryWindow,
	type SessionIndexEntry,
} from "@/lib/api/sessions";

type ForkSessionTarget = {
	sessionId: string;
	sessionPath: string;
};

type RemoveIndexedSessionResult = {
	session: SessionIndexEntry;
	result: {
		method: string;
	};
};

type UseAppChatSessionActionsOptions = {
	activeProjectId: string | null;
	indexedSessions: SessionIndexEntry[];
	openedChats: OpenChat[];
	updateIndexedSession: (
		sessionId: string,
		update: { title?: string },
		projectId: string,
	) => Promise<SessionIndexEntry | null>;
	removeIndexedSession: (
		sessionId: string,
		projectId: string,
	) => Promise<RemoveIndexedSessionResult | null>;
	setOpenedChats: Dispatch<SetStateAction<OpenChat[]>>;
	setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
	chatUiStateCacheRef: MutableRefObject<ChatUiStateCache | null>;
	draftSessionId: string;
	clearDraftSession: () => void;
	busyChatControllersRef: BusyChatControllersRef;
	setDraftProjectId: Dispatch<SetStateAction<string | null>>;
	setFocusedProjectId: Dispatch<SetStateAction<string | null>>;
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
};

export function useAppChatSessionActions({
	activeProjectId,
	indexedSessions,
	openedChats,
	updateIndexedSession,
	removeIndexedSession,
	setOpenedChats,
	setSelectedSessionId,
	chatUiStateCacheRef,
	draftSessionId,
	clearDraftSession,
	busyChatControllersRef,
	setDraftProjectId,
	setFocusedProjectId,
	refreshProjectSessions,
}: UseAppChatSessionActionsOptions) {
	const { t } = useTranslation();
	const activeProjectIdRef = useRef(activeProjectId);
	useEffect(() => {
		activeProjectIdRef.current = activeProjectId;
	}, [activeProjectId]);

	const sessionRefreshHandlersRef = useRef(
		new Map<string, (sessionPath: string) => Promise<void>>(),
	);
	const registerSessionRefresh = useCallback(
		(
			controllerId: string,
			refresh: ((sessionPath: string) => Promise<void>) | null,
		) => {
			if (refresh) sessionRefreshHandlersRef.current.set(controllerId, refresh);
			else sessionRefreshHandlersRef.current.delete(controllerId);
		},
		[],
	);
	const refreshSession = useCallback(
		async (sessionId: string, projectId: string) => {
			const indexed = indexedSessions.find(
				(entry) =>
					entry.projectId === projectId && entry.piSessionId === sessionId,
			);
			const opened = openedChats.find(
				(entry) =>
					entry.session.projectRecord.id === projectId &&
					(entry.piSessionId ?? entry.session.id) === sessionId,
			);
			const path = opened?.session.sessionPath ?? indexed?.sessionPath;
			if (!path) throw new Error(t("chat.sessionPathUnavailable"));
			if (opened && busyChatControllersRef.current.has(opened.controllerId)) {
				throw new Error(t("chat.refreshSessionRunning"));
			}
			const [states, external] = await Promise.all([
				listChatSessionRuntimeStates(),
				getExternalSessionActivity(projectId),
			]);
			const runtime = findReusableChatRuntime(states, projectId, path);
			if (
				chatRuntimeHasOpenTurn(runtime) ||
				runtime?.compacting ||
				external.some((entry) => entry.path === path && entry.turnOpen)
			) {
				throw new Error(t("chat.refreshSessionRunning"));
			}
			const handler =
				opened && sessionRefreshHandlersRef.current.get(opened.controllerId);
			if (handler) {
				await handler(path);
			} else {
				if (runtime?.initialized && runtime.snapshot.state === "running") {
					const state = await requestPiRpc<PiAgentState>(
						{ type: "get_state" },
						undefined,
						runtime.sessionKey,
					);
					if (state.isStreaming || state.isCompacting) {
						throw new Error(t("chat.refreshSessionRunning"));
					}
				}
				await loadSessionHistoryWindow(projectId, path, {
					messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
					includeMessageIndex: true,
				});
			}
			await refreshProjectSessions(projectId);
		},
		[
			busyChatControllersRef,
			indexedSessions,
			openedChats,
			refreshProjectSessions,
			t,
		],
	);

	const updateSession = useCallback(
		async (
			sessionId: string,
			update: { title?: string },
			projectId: string,
		) => {
			await updateIndexedSession(sessionId, update, projectId);
		},
		[updateIndexedSession],
	);

	const deleteSession = useCallback(
		async (sessionId: string, projectId: string) => {
			const session = indexedSessions.find(
				(candidate) =>
					candidate.projectId === projectId &&
					candidate.piSessionId === sessionId,
			);
			if (!session) {
				// 未进入索引的会话（例如启动即报错、从未生成 Pi 会话文件）不会持久化到磁盘，
				// 只挂在打开的聊天列表里；把它移除即可，否则会永远卡在侧栏且删除无效。
				const pending = openedChats.find(
					(entry) =>
						entry.session.projectRecord.id === projectId &&
						(entry.session.id === sessionId || entry.piSessionId === sessionId),
				);
				if (!pending) return;
				try {
					await stopChatSession(
						pending.session.projectRecord.id,
						pending.session.id,
						"session_delete",
					);
				} catch (error) {
					console.error("Failed to stop pending chat session", error);
					return;
				}
				setOpenedChats((current) =>
					current.filter(
						(entry) =>
							entry.session.projectRecord.id !== projectId ||
							(entry.session.id !== sessionId &&
								entry.piSessionId !== sessionId),
					),
				);
				setSelectedSessionId((current) =>
					activeProjectIdRef.current === projectId && current === sessionId
						? null
						: current,
				);
				if (pending.session.id === draftSessionId) clearDraftSession();
				return;
			}
			try {
				const deleted = await removeIndexedSession(sessionId, projectId);
				if (!deleted) return;
				setOpenedChats((current) =>
					current.filter(
						(entry) =>
							entry.session.projectRecord.id !== projectId ||
							(entry.session.id !== sessionId &&
								entry.piSessionId !== sessionId),
					),
				);
				setSelectedSessionId((current) =>
					activeProjectIdRef.current === projectId && current === sessionId
						? null
						: current,
				);
				toast.success(
					deleted.result.method === "trash"
						? t("app.sessionTrashed")
						: t("app.sessionDeleted"),
				);
			} catch (error) {
				toast.error(t("app.deleteSessionFailed"), {
					description: userErrorMessage(error),
				});
			}
		},
		[
			indexedSessions,
			openedChats,
			clearDraftSession,
			draftSessionId,
			removeIndexedSession,
			setOpenedChats,
			setSelectedSessionId,
			t,
		],
	);

	const handleSessionIdentified = useCallback(
		(entry: OpenChat, piSessionId: string) => {
			const nextUiStateKey = chatUiStateKey(
				entry.session.projectRecord.id,
				piSessionId,
			);
			chatUiStateCacheRef.current!.rekey(entry.uiStateKey, nextUiStateKey);
			setOpenedChats((current) =>
				identifyOpenedChat(current, entry.controllerId, piSessionId),
			);
			if (entry.session.id === draftSessionId) {
				clearDraftSession();
			}
			setSelectedSessionId((current) =>
				activeProjectIdRef.current === entry.session.projectRecord.id &&
				(current === entry.session.id || current === entry.piSessionId)
					? piSessionId
					: current,
			);
		},
		[
			chatUiStateCacheRef,
			clearDraftSession,
			draftSessionId,
			setOpenedChats,
			setSelectedSessionId,
		],
	);

	const handleForkSessionCreated = useCallback(
		(entry: OpenChat, { sessionId, sessionPath }: ForkSessionTarget) => {
			const project = entry.session.projectRecord;
			const forkedSession: ChatSession = {
				id: sessionId,
				title: entry.session.title || t("app.newChat"),
				projectRecord: project,
				sessionPath,
			};
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, forkedSession),
					busyChatControllersRef.current,
				),
			);
			setSelectedSessionId(sessionId);
			clearDraftSession();
			setDraftProjectId(project.id);
			setFocusedProjectId(project.id);
			void refreshProjectSessions(project.id, true).catch((error) =>
				console.error("Failed to index forked session", error),
			);
		},
		[
			busyChatControllersRef,
			clearDraftSession,
			refreshProjectSessions,
			setDraftProjectId,
			setFocusedProjectId,
			setOpenedChats,
			setSelectedSessionId,
			t,
		],
	);

	return {
		registerSessionRefresh,
		refreshSession,
		updateSession,
		deleteSession,
		handleSessionIdentified,
		handleForkSessionCreated,
	};
}
