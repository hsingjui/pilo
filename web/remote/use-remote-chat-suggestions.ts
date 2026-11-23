import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
	piSessionSuggestions,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer-suggestions";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
	mergePiCommands,
} from "@shared/chat/pi-command-suggestions";
import type { PiCommand } from "@/lib/api/pi-runtime";
import type { RemoteSessionRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatSuggestionsOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	activeSessionKeyRef: RefObject<string | null>;
	commands: PiCommand[] | null;
	runtimeReady: boolean;
	readOnly: boolean;
	rpcForSession: RemoteSessionRpc;
};

export function useRemoteChatSuggestions({
	client,
	activeProjectId,
	activeSessionKey,
	activeSessionKeyRef,
	commands,
	runtimeReady,
	readOnly,
	rpcForSession,
}: UseRemoteChatSuggestionsOptions) {
	const { t } = useTranslation();

	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const [sessionCommands, setSessionCommands] = useState<{
		sessionKey: string;
		commands: PiCommand[];
	} | null>(null);
	const sessionCommandsRef = useRef<{
		sessionKey: string;
		commands: PiCommand[];
	} | null>(null);
	const sessionCommandsLoadingRef = useRef<{
		sessionKey: string;
		promise: Promise<PiCommand[] | null>;
	} | null>(null);

	const loadSessionCommands = useCallback(async () => {
		if (!activeSessionKey || !runtimeReady || readOnly) return null;
		if (sessionCommandsRef.current?.sessionKey === activeSessionKey) {
			return sessionCommandsRef.current.commands;
		}
		if (sessionCommandsLoadingRef.current?.sessionKey === activeSessionKey) {
			return sessionCommandsLoadingRef.current.promise;
		}
		const targetSessionKey = activeSessionKey;
		const load = (async (): Promise<PiCommand[] | null> => {
			try {
				const reply = await rpcForSession<{ commands: PiCommand[] }>(
					targetSessionKey,
					{ type: "get_commands" },
				);
				const nextCommands = reply?.commands ?? [];
				if (activeSessionKeyRef.current === targetSessionKey) {
					const next = { sessionKey: targetSessionKey, commands: nextCommands };
					sessionCommandsRef.current = next;
					setSessionCommands(next);
				}
				return nextCommands;
			} catch (error) {
				console.warn(
					"Failed to load live Pi commands for remote composer",
					error,
				);
				return null;
			}
		})();
		const request = load.finally(() => {
			if (sessionCommandsLoadingRef.current?.promise === request) {
				sessionCommandsLoadingRef.current = null;
			}
		});
		sessionCommandsLoadingRef.current = {
			sessionKey: targetSessionKey,
			promise: request,
		};
		return request;
	}, [
		activeSessionKey,
		activeSessionKeyRef,
		readOnly,
		rpcForSession,
		runtimeReady,
	]);

	const activeSessionCommands =
		sessionCommands?.sessionKey === activeSessionKey
			? sessionCommands.commands
			: null;
	const mergedCommands = useMemo(
		() => mergePiCommands(commands, activeSessionCommands),
		[activeSessionCommands, commands],
	);
	const commandSuggestions = useMemo(
		() => createPiCommandSuggestions(mergedCommands),
		[mergedCommands],
	);
	const extensionCommandNames = useMemo(
		() => createPiExtensionCommandNames(mergedCommands),
		[mergedCommands],
	);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);

	const loadExtensionCommandNames = useCallback(async () => {
		if (readOnly) return null;
		const liveCommands =
			runtimeReady && activeSessionKey
				? await loadSessionCommands()
				: activeSessionCommands;
		if (commands != null) {
			return liveCommands
				? createPiExtensionCommandNames(mergePiCommands(commands, liveCommands))
				: extensionCommandNames;
		}
		const loaded = await client?.loadModels(activeProjectId);
		const projectCommands = loaded?.commands ?? null;
		if (projectCommands == null && liveCommands == null) return null;
		return createPiExtensionCommandNames(
			mergePiCommands(projectCommands, liveCommands),
		);
	}, [
		activeProjectId,
		activeSessionCommands,
		activeSessionKey,
		client,
		commands,
		extensionCommandNames,
		loadSessionCommands,
		readOnly,
		runtimeReady,
	]);

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
				// 仅在会话 Pi 已运行时被动补充插件命令，不触发启动。
				if (runtimeReady && !readOnly) void loadSessionCommands();
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
		[activeProjectId, client, loadSessionCommands, readOnly, runtimeReady],
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
