import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { ChatSession } from "@/components/chat/chat-page-utils";
import { userErrorMessage } from "@/lib/app-error";
import {
	createChatSessionClient,
	type ChatSessionClient,
} from "@/lib/chat-session-client";
import { resolveAssistantForkTarget } from "@/lib/pi-session-fork";
import type { ChatMessage } from "@/lib/conversation-types";

/**
 * Fork / clone a persisted session at an assistant message. Owns the in-flight
 * message id so callers can disable the per-message fork action.
 */
export function useChatFork({
	client,
	session,
	runtimeBusy,
	historyPending,
	getConversationMessages,
	onForkSessionCreated,
}: {
	client: ChatSessionClient;
	session: ChatSession;
	runtimeBusy: boolean;
	historyPending: boolean;
	getConversationMessages: () => ChatMessage[];
	onForkSessionCreated?: (session: {
		sessionId: string;
		sessionPath: string;
	}) => void;
}) {
	const { t } = useTranslation();
	const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

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
					throw new Error(t("chat.forkUnsaved"));
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
					toast.info(t("chat.forkCancelled"));
					return;
				}

				const state = await forkClient.getPiAgentState();
				if (!state.sessionId || !state.sessionFile) {
					throw new Error(t("chat.forkNoInfo"));
				}
				forkedSession = {
					sessionId: state.sessionId,
					sessionPath: state.sessionFile,
				};
			} catch (error) {
				toast.error(t("chat.forkFailed"), {
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
			t,
		],
	);

	return { forkingMessageId, handleForkAssistant };
}
