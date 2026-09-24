import { useCallback, useEffect, useRef, useState } from "react";

import type { ComposerSuggestion } from "@/components/chat/chat-composer";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import { searchProjectFiles } from "@/lib/files";

const FILE_SUGGESTION_DEBOUNCE_MS = 180;
const FILE_SUGGESTION_CACHE_TTL_MS = 10_000;
const FILE_SUGGESTION_CACHE_MAX_ENTRIES = 24;

type FileSuggestionCacheEntry = {
	expiresAt: number;
	suggestions: ComposerSuggestion[];
};

/**
 * Debounced `@`-triggered project file suggestions, keyed by project + query.
 * `/` and empty triggers clear file suggestions; `/` also hands off to the
 * caller so it can load slash commands.
 */
export function useChatFileSuggestions({
	projectId,
	onCommandsTrigger,
}: {
	projectId: string;
	onCommandsTrigger?: () => void;
}) {
	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);
	const fileSuggestionCacheRef = useRef<Map<string, FileSuggestionCacheEntry>>(
		new Map(),
	);

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
				onCommandsTrigger?.();
				return;
			}
			if (trigger !== "@") {
				setFileSuggestions([]);
				return;
			}
			const normalizedQuery = query.trim();
			const cacheKey = `${projectId}\0${normalizedQuery.toLowerCase()}`;
			const cached = fileSuggestionCacheRef.current.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				fileSuggestionCacheRef.current.delete(cacheKey);
				fileSuggestionCacheRef.current.set(cacheKey, cached);
				setFileSuggestions(cached.suggestions);
				return;
			}
			if (cached) fileSuggestionCacheRef.current.delete(cacheKey);

			fileSuggestionTimerRef.current = window.setTimeout(() => {
				fileSuggestionTimerRef.current = null;
				void searchProjectFiles(projectId, normalizedQuery)
					.then((paths) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						const suggestions = createFileSuggestions(paths, normalizedQuery);
						fileSuggestionCacheRef.current.set(cacheKey, {
							expiresAt: Date.now() + FILE_SUGGESTION_CACHE_TTL_MS,
							suggestions,
						});
						while (
							fileSuggestionCacheRef.current.size >
							FILE_SUGGESTION_CACHE_MAX_ENTRIES
						) {
							const oldestKey = fileSuggestionCacheRef.current
								.keys()
								.next().value;
							if (oldestKey === undefined) break;
							fileSuggestionCacheRef.current.delete(oldestKey);
						}
						setFileSuggestions(suggestions);
					})
					.catch((error) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						console.warn("Failed to load file suggestions", error);
						setFileSuggestions([]);
					});
			}, FILE_SUGGESTION_DEBOUNCE_MS);
		},
		[onCommandsTrigger, projectId],
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

	return { fileSuggestions, handleSuggestionTrigger };
}
