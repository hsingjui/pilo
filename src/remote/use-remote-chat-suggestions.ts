import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	piSessionSuggestions,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer-suggestions";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
} from "@/lib/pi-command-suggestions";
import type { PiCommand } from "@/lib/pi-runtime";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatSuggestionsOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	readOnly: boolean;
	ensureDraftRuntime: () => Promise<void>;
	rpc: <T>(command: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
};

export function useRemoteChatSuggestions({
	client,
	activeProjectId,
	readOnly,
	ensureDraftRuntime,
	rpc,
}: UseRemoteChatSuggestionsOptions) {
	const { t } = useTranslation();

	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const [commandSuggestions, setCommandSuggestions] = useState<
		ComposerSuggestion[]
	>([]);
	const extensionCommandNamesRef = useRef<Set<string>>(new Set());
	const commandsLoadedRef = useRef(false);
	const commandLoadingRef = useRef(false);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);

	const loadCommands = useCallback(async () => {
		if (commandsLoadedRef.current || commandLoadingRef.current || readOnly)
			return;
		commandLoadingRef.current = true;
		try {
			await ensureDraftRuntime();
			const result = await rpc<{ commands: PiCommand[] }>({
				type: "get_commands",
			});
			extensionCommandNamesRef.current = createPiExtensionCommandNames(
				result.commands,
			);
			setCommandSuggestions(createPiCommandSuggestions(result.commands));
			commandsLoadedRef.current = true;
		} catch (error) {
			console.warn("Failed to load Pi commands for remote composer", error);
		} finally {
			commandLoadingRef.current = false;
		}
	}, [ensureDraftRuntime, readOnly, rpc]);

	// Resolve the extension command set for `/name` submissions, loading it on demand.
	// Returns null when the command catalog cannot be fetched.
	const loadExtensionCommandNames = useCallback(async () => {
		if (commandsLoadedRef.current) return extensionCommandNamesRef.current;
		try {
			await ensureDraftRuntime();
			const result = await rpc<{ commands: PiCommand[] }>({
				type: "get_commands",
			});
			extensionCommandNamesRef.current = createPiExtensionCommandNames(
				result.commands,
			);
			setCommandSuggestions(createPiCommandSuggestions(result.commands));
			commandsLoadedRef.current = true;
			return extensionCommandNamesRef.current;
		} catch {
			return null;
		}
	}, [ensureDraftRuntime, rpc]);

	const handleSuggestionTrigger = useCallback(
		(trigger: "@" | "/" | null, query: string) => {
			fileSuggestionRequestRef.current += 1;
			const requestId = fileSuggestionRequestRef.current;
			if (fileSuggestionTimerRef.current !== null) {
				window.clearTimeout(fileSuggestionTimerRef.current);
				fileSuggestionTimerRef.current = null;
			}
			if (trigger === "/") {
				setFileSuggestions([]);
				void loadCommands();
				return;
			}
			if (trigger !== "@" || !client || !activeProjectId) {
				setFileSuggestions([]);
				return;
			}
			const normalizedQuery = query.trim();
			fileSuggestionTimerRef.current = window.setTimeout(() => {
				fileSuggestionTimerRef.current = null;
				void client
					.searchFiles(activeProjectId, normalizedQuery)
					.then((paths) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						setFileSuggestions(createFileSuggestions(paths, normalizedQuery));
					})
					.catch((error) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						console.warn("Failed to load remote file suggestions", error);
						setFileSuggestions([]);
					});
			}, 120);
		},
		[activeProjectId, client, loadCommands],
	);

	useEffect(
		() => () => {
			fileSuggestionRequestRef.current += 1;
			if (fileSuggestionTimerRef.current !== null) {
				window.clearTimeout(fileSuggestionTimerRef.current);
			}
		},
		[],
	);

	const composerSuggestions = useMemo(
		() => [
			...fileSuggestions,
			...piSessionSuggestions(t),
			...commandSuggestions,
		],
		[commandSuggestions, fileSuggestions, t],
	);

	return {
		composerSuggestions,
		handleSuggestionTrigger,
		loadExtensionCommandNames,
	};
}
