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
} from "@/lib/chat/pi-command-suggestions";
import type { PiCommand } from "@/lib/api/pi-runtime";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatSuggestionsOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	commands: PiCommand[] | null;
	readOnly: boolean;
};

export function useRemoteChatSuggestions({
	client,
	activeProjectId,
	commands,
	readOnly,
}: UseRemoteChatSuggestionsOptions) {
	const { t } = useTranslation();

	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const commandSuggestions = useMemo(
		() => createPiCommandSuggestions(commands ?? []),
		[commands],
	);
	const extensionCommandNames = useMemo(
		() => createPiExtensionCommandNames(commands ?? []),
		[commands],
	);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);

	const loadExtensionCommandNames = useCallback(async () => {
		if (readOnly) return null;
		if (commands != null) return extensionCommandNames;
		const loaded = await client?.loadModels(activeProjectId);
		return loaded?.commands == null
			? null
			: createPiExtensionCommandNames(loaded.commands);
	}, [activeProjectId, client, commands, extensionCommandNames, readOnly]);

	const handleSuggestionTrigger = useCallback(
		(trigger: "@" | "/" | null, query: string) => {
			fileSuggestionRequestRef.current += 1;
			const requestId = fileSuggestionRequestRef.current;
			if (fileSuggestionTimerRef.current !== null) {
				window.clearTimeout(fileSuggestionTimerRef.current);
				fileSuggestionTimerRef.current = null;
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
		[activeProjectId, client],
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
