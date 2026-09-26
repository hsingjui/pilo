import {
	useCallback,
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
} from "react";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import type { PiAgentState } from "@/lib/pi-runtime";
import type { SessionIndexEntry } from "@/lib/sessions";
import type { RemoteSessionRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatAutoTitleOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	selectedSession: SessionIndexEntry | null;
	draftTemporary: boolean;
	autoTitleRequestedRef: MutableRefObject<boolean>;
	activeSessionKeyRef: MutableRefObject<string | null>;
	rpcForSession: RemoteSessionRpc;
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
	autoTitleRequestedRef,
	activeSessionKeyRef,
	rpcForSession,
	refreshProjectSessions,
	handleExpiredAuth,
	setAgentState,
	setChatState,
}: UseRemoteChatAutoTitleOptions) {
	return useCallback(
		(message: string) => {
			const prompt = message.trim();
			if (
				!client ||
				!activeProjectId ||
				!activeSessionKey ||
				selectedSession ||
				draftTemporary ||
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
			activeSessionKeyRef,
			autoTitleRequestedRef,
			client,
			draftTemporary,
			handleExpiredAuth,
			refreshProjectSessions,
			rpcForSession,
			selectedSession,
			setAgentState,
			setChatState,
		],
	);
}
