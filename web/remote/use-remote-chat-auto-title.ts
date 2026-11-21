import {
	useCallback,
	useRef,
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
} from "react";

import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { userErrorMessage } from "@shared/app-error";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import type { PiAgentState } from "@/lib/api/pi-runtime";
import type { SessionIndexEntry } from "@/lib/api/sessions";
import type { RemoteSessionRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatAutoTitleOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	selectedSession: SessionIndexEntry | null;
	draftTemporary: boolean;
	activeSessionKeyRef: MutableRefObject<string | null>;
	rpcForSession: RemoteSessionRpc;
	confirmSessionName: (
		projectId: string,
		sessionPath: string,
		name: string,
	) => void;
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
	handleExpiredAuth: (error: unknown) => boolean;
	setAgentState: Dispatch<SetStateAction<PiAgentState | null>>;
	setChatState: Dispatch<SetStateAction<ChatSessionRuntimeState | null>>;
};

export function useRemoteChatAutoTitle({
	client,
	activeProjectId,
	activeSessionKey,
	selectedSession,
	draftTemporary,
	activeSessionKeyRef,
	rpcForSession,
	confirmSessionName,
	refreshProjectSessions,
	handleExpiredAuth,
	setAgentState,
	setChatState,
}: UseRemoteChatAutoTitleOptions) {
	const { t } = useTranslation();
	const requestedSessionKeysRef = useRef(new Set<string>());
	return useCallback(
		(message: string) => {
			const prompt = message.trim();
			if (
				!client ||
				!activeProjectId ||
				!activeSessionKey ||
				selectedSession ||
				draftTemporary ||
				requestedSessionKeysRef.current.has(activeSessionKey) ||
				!prompt
			) {
				return;
			}
			requestedSessionKeysRef.current.add(activeSessionKey);
			const targetSessionKey = activeSessionKey;
			void client
				.generateSessionTitle(activeProjectId, prompt)
				.then(async (title) => {
					if (!title) return;
					const state = await rpcForSession<PiAgentState>(targetSessionKey, {
						type: "get_state",
					});
					const existingName = state.sessionName?.trim();
					const name = existingName || title;
					if (!existingName) {
						await rpcForSession<void>(targetSessionKey, {
							type: "set_session_name",
							name,
						});
					}
					if (state.sessionFile) {
						confirmSessionName(activeProjectId, state.sessionFile, name);
					}
					if (activeSessionKeyRef.current === targetSessionKey) {
						setAgentState((current) =>
							current ? { ...current, sessionName: name } : current,
						);
						setChatState((current) =>
							current ? { ...current, name } : current,
						);
					}
					void refreshProjectSessions(activeProjectId, true);
				})
				.catch((error) => {
					if (!handleExpiredAuth(error)) {
						toast.error(t("settings.automaticNamingFailed"), {
							description: userErrorMessage(error),
						});
					}
				});
		},
		[
			activeProjectId,
			activeSessionKey,
			activeSessionKeyRef,
			client,
			confirmSessionName,
			draftTemporary,
			handleExpiredAuth,
			refreshProjectSessions,
			rpcForSession,
			selectedSession,
			setAgentState,
			setChatState,
			t,
		],
	);
}
