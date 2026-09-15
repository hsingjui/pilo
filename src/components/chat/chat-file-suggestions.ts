import type { ComposerSuggestion } from "@/components/chat/chat-composer-suggestions";

const FILE_SUGGESTION_LIMIT = 5;

function fileSuggestionScore(path: string, query: string) {
	if (!query) return 1;
	const normalizedPath = path.toLowerCase();
	const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	const normalizedQuery = query.toLowerCase();
	if (fileName === normalizedQuery) return 100;
	if (fileName.startsWith(normalizedQuery)) return 80;
	if (fileName.includes(normalizedQuery)) return 50;
	if (normalizedPath.includes(normalizedQuery)) return 30;
	return 0;
}

function fileSuggestionDepth(path: string) {
	return path.split("/").filter(Boolean).length;
}

function fileMentionValue(path: string) {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function compareFileSuggestionEntries(
	a: { path: string; score: number },
	b: { path: string; score: number },
) {
	const scoreDiff = b.score - a.score;
	if (scoreDiff !== 0) return scoreDiff;
	const depthDiff = fileSuggestionDepth(a.path) - fileSuggestionDepth(b.path);
	if (depthDiff !== 0) return depthDiff;
	const lengthDiff = a.path.length - b.path.length;
	if (lengthDiff !== 0) return lengthDiff;
	return a.path.localeCompare(b.path);
}

export function createFileSuggestions(
	paths: readonly string[],
	query: string,
): ComposerSuggestion[] {
	const normalizedQuery = query.trim();
	const ranked: Array<{ path: string; score: number }> = [];
	if (!normalizedQuery) {
		for (const path of paths.slice(0, FILE_SUGGESTION_LIMIT)) {
			ranked.push({ path, score: 1 });
		}
	} else {
		for (const path of paths) {
			const entry = { path, score: fileSuggestionScore(path, normalizedQuery) };
			if (entry.score <= 0) continue;
			const insertAt = ranked.findIndex(
				(current) => compareFileSuggestionEntries(entry, current) < 0,
			);
			if (insertAt < 0) ranked.push(entry);
			else ranked.splice(insertAt, 0, entry);
			if (ranked.length > FILE_SUGGESTION_LIMIT) ranked.pop();
		}
	}

	return ranked.map(({ path }) => {
		const separator = path.lastIndexOf("/");
		return {
			kind: "file" as const,
			value: fileMentionValue(path),
			label: separator >= 0 ? path.slice(separator + 1) : path,
			detail: separator >= 0 ? path.slice(0, separator) : undefined,
		};
	});
}
