import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
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
import { stopChatSession } from "@/lib/chat-session-client";
import type { SessionIndexEntry } from "@/lib/sessions";

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
	indexedSessions: SessionIndexEntry[];
	openedChats: OpenChat[];
	updateIndexedSession: (
		sessionId: string,
		update: { title?: string },
	) => Promise<SessionIndexEntry | null>;
	removeIndexedSession: (
		sessionId: string,
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

	const updateSession = useCallback(
		async (sessionId: string, update: { title?: string }) => {
			await updateIndexedSession(sessionId, update);
		},
		[updateIndexedSession],
	);

	const deleteSession = useCallback(
		async (sessionId: string) => {
			const session = indexedSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			if (!session) {
				// 未进入索引的会话（例如启动即报错、从未生成 Pi 会话文件）不会持久化到磁盘，
				// 只挂在打开的聊天列表里；把它移除即可，否则会永远卡在侧栏且删除无效。
				const pending = openedChats.find(
					(entry) =>
						entry.session.id === sessionId || entry.piSessionId === sessionId,
				);
				if (!pending) return;
				try {
					await stopChatSession(
						pending.session.projectRecord.id,
						sessionId,
						"session_delete",
					);
				} catch (error) {
					console.error("Failed to stop pending chat session", error);
				}
				setOpenedChats((current) =>
					current.filter(
						(entry) =>
							entry.session.id !== sessionId && entry.piSessionId !== sessionId,
					),
				);
				setSelectedSessionId((current) =>
					current === sessionId ? null : current,
				);
				if (pending.session.id === draftSessionId) clearDraftSession();
				return;
			}
			try {
				await stopChatSession(session.projectId, sessionId, "session_delete");
				const deleted = await removeIndexedSession(sessionId);
				if (!deleted) return;
				setOpenedChats((current) =>
					current.filter(
						(entry) =>
							entry.session.id !== sessionId && entry.piSessionId !== sessionId,
					),
				);
				setSelectedSessionId((current) =>
					current === sessionId ? null : current,
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
				current === entry.session.id || current === entry.piSessionId
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
		updateSession,
		deleteSession,
		handleSessionIdentified,
		handleForkSessionCreated,
	};
}
