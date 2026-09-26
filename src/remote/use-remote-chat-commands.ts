import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { ChatSubmission } from "@/lib/chat-submission";
import type { PiCompactionResult } from "@/lib/pi-runtime";
import type { RemoteRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatCommandsOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	clearComposer: () => void;
	ensureDraftRuntime: () => Promise<void>;
	handleExpiredAuth: (error: unknown) => boolean;
	loadExtensionCommandNames: () => Promise<Set<string> | null>;
	rpc: RemoteRpc;
	startDraft: (projectId?: string) => void;
	setFatalError: (message: string | null) => void;
};

export function useRemoteChatCommands({
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
}: UseRemoteChatCommandsOptions) {
	const { t } = useTranslation();

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
			const extensionNames = await loadExtensionCommandNames();
			if (!extensionNames || !extensionNames.has(commandName)) return false;
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
			loadExtensionCommandNames,
			rpc,
			startDraft,
			t,
			setFatalError,
		],
	);

	return { tryHandleComposerCommand };
}
