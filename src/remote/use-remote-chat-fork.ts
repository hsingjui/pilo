import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
import type { ChatMessage } from "@/lib/conversation-types";
import { resolveAssistantForkTarget } from "@/lib/pi-session-fork";
import type { PiAgentState, PiSessionEntries } from "@/lib/pi-runtime";
import type { SessionIndexEntry } from "@/lib/sessions";
import { randomId } from "@/lib/utils";
import { sessionKey } from "./remote-app-model";
import type { RemoteSessionRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

export function useRemoteChatFork({
	client,
	activeProjectId,
	activeSessionKey,
	selectedSession,
	messages,
	busy,
	rpcForSession,
	refreshProjectSessions,
	onForkSessionCreated,
}: {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	selectedSession: SessionIndexEntry | null;
	messages: readonly ChatMessage[];
	busy: boolean;
	rpcForSession: RemoteSessionRpc;
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
	onForkSessionCreated: (sessionId: string) => void;
}) {
	const { t } = useTranslation();
	const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

	const handleForkAssistant = useCallback(
		async (messageId: string) => {
			if (
				!client ||
				!activeProjectId ||
				!activeSessionKey ||
				!selectedSession ||
				busy ||
				forkingMessageId
			) {
				return;
			}

			setForkingMessageId(messageId);
			let forkSessionKey: string | null = null;
			try {
				const [sourceState, entries] = await Promise.all([
					rpcForSession<PiAgentState>(activeSessionKey, { type: "get_state" }),
					rpcForSession<PiSessionEntries>(activeSessionKey, {
						type: "get_entries",
					}),
				]);
				if (!sourceState.sessionFile) {
					throw new Error(t("chat.forkUnsaved"));
				}

				const target = resolveAssistantForkTarget(messages, messageId, entries);
				forkSessionKey = sessionKey(
					activeProjectId,
					`fork-runtime-${randomId()}`,
				);
				await client.startChat({
					projectId: activeProjectId,
					sessionKey: forkSessionKey,
					sessionPath: sourceState.sessionFile,
				});
				const result =
					target.type === "clone"
						? await rpcForSession<{ cancelled: boolean }>(
								forkSessionKey,
								{ type: "clone" },
								30_000,
							)
						: await rpcForSession<{ cancelled: boolean }>(
								forkSessionKey,
								{ type: "fork", entryId: target.entryId },
								30_000,
							);
				if (result.cancelled) {
					toast.info(t("chat.forkCancelled"));
					return;
				}

				const state = await rpcForSession<PiAgentState>(
					forkSessionKey,
					{ type: "get_state" },
					10_000,
				);
				if (!state.sessionId || !state.sessionFile) {
					throw new Error(t("chat.forkNoInfo"));
				}
				await refreshProjectSessions(activeProjectId, true);
				onForkSessionCreated(state.sessionId);
			} catch (error) {
				toast.error(t("chat.forkFailed"), {
					description: userErrorMessage(error),
				});
			} finally {
				if (forkSessionKey) {
					await client
						.stopChat(forkSessionKey, "fork_cleanup")
						.catch(() => undefined);
				}
				setForkingMessageId(null);
			}
		},
		[
			activeProjectId,
			activeSessionKey,
			busy,
			client,
			forkingMessageId,
			messages,
			onForkSessionCreated,
			refreshProjectSessions,
			rpcForSession,
			selectedSession,
			t,
		],
	);

	return { forkingMessageId, handleForkAssistant };
}
