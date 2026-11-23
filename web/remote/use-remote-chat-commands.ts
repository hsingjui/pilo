import { type RefObject, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { ChatSubmission } from "@shared/chat/chat-submission";
import { parseSlashCommand } from "@shared/chat/pi-command-suggestions";
import type { PiCompactionResult } from "@/lib/api/pi-runtime";
import type { RemoteSessionRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatCommandsOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	activeSessionKeyRef: RefObject<string | null>;
	clearComposer: () => void;
	ensureDraftRuntime: () => Promise<void>;
	handleExpiredAuth: (error: unknown) => boolean;
	loadExtensionCommandNames: () => Promise<Set<string> | null>;
	rpcForSession: RemoteSessionRpc;
	startDraft: (projectId?: string) => void;
	setFatalError: (message: string | null) => void;
};

export function useRemoteChatCommands({
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
}: UseRemoteChatCommandsOptions) {
	const { t } = useTranslation();

	const tryHandleComposerCommand = useCallback(
		async (submission: ChatSubmission) => {
			const parsed = parseSlashCommand(submission.text);
			if (!parsed) return false;
			const { name: commandName, args, raw: command } = parsed;
			if (commandName === "new") {
				clearComposer();
				startDraft(activeProjectId || undefined);
				return true;
			}
			if (!client || !activeSessionKey) return false;
			const targetSessionKey = activeSessionKey;
			const isActiveSession = () =>
				activeSessionKeyRef.current === targetSessionKey;
			if (commandName === "compact") {
				clearComposer();
				try {
					await ensureDraftRuntime();
					const result = await rpcForSession<PiCompactionResult>(
						targetSessionKey,
						{
							type: "compact",
							...(args ? { customInstructions: args } : {}),
						},
						120_000,
					);
					toast.success(t("chat.compactSuccess"), {
						description: `${result.tokensBefore.toLocaleString()} → ${result.estimatedTokensAfter.toLocaleString()} tokens`,
					});
				} catch (error) {
					if (!handleExpiredAuth(error) && isActiveSession()) {
						setFatalError(
							error instanceof Error ? error.message : String(error),
						);
					}
				}
				return true;
			}
			try {
				const extensionNames = await loadExtensionCommandNames();
				// A switched-away command must not clear or submit the new session's draft.
				if (!isActiveSession()) return true;
				if (extensionNames === null)
					throw new Error(t("chat.readCommandsFailed"));
				if (!extensionNames.has(commandName)) return false;
				await ensureDraftRuntime();
				if (!isActiveSession()) return true;
				await client.sendChatCommand(targetSessionKey, {
					type: "prompt",
					message: command,
				});
				if (isActiveSession()) clearComposer();
			} catch (error) {
				if (!handleExpiredAuth(error) && isActiveSession()) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			}
			return true;
		},
		[
			activeProjectId,
			activeSessionKey,
			activeSessionKeyRef,
			clearComposer,
			client,
			ensureDraftRuntime,
			handleExpiredAuth,
			loadExtensionCommandNames,
			rpcForSession,
			startDraft,
			t,
			setFatalError,
		],
	);

	return { tryHandleComposerCommand };
}
