import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";

export function chatRpcChangesActivity(message: unknown) {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "response" &&
		"command" in message &&
		(message.command === "prompt" || message.command === "compact")
	);
}

export function chatRpcRenamesSession(message: unknown) {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "response" &&
		"command" in message &&
		message.command === "set_session_name" &&
		"success" in message &&
		message.success === true
	);
}

export function chatRuntimeHasOpenTurn(
	state: ChatSessionRuntimeState | null | undefined,
) {
	// A process that is still starting can already own an accepted prompt, so it
	// must not be mistaken for a runtime without a turn.
	return (
		state?.activeTurn === true &&
		(state.snapshot.state === "running" || state.snapshot.state === "starting")
	);
}

/** Whether the sidebar shows the chat as running: an open turn, or a compaction. */
export function chatRuntimeShowsActivity(
	state: ChatSessionRuntimeState | null | undefined,
) {
	return (
		chatRuntimeHasOpenTurn(state) ||
		(state?.compacting === true && state.snapshot.state === "running")
	);
}

// Pi and the session index can spell the same Windows path with different separators,
// drive letter casing, or verbatim prefixes (`\\?\`).
export function runtimeSessionPathKey(path: string): string {
	let normalized = path;
	if (/^\\\\\?\\UNC\\/i.test(normalized)) {
		normalized = `\\\\${normalized.slice(8)}`;
	} else if (/^\\\\\?\\[a-z]:[\\/]/i.test(normalized)) {
		normalized = normalized.slice(4);
	}
	if (/^[a-z]:[\\/]/i.test(normalized)) {
		return `${normalized[0].toLowerCase()}${normalized.slice(1).replaceAll("\\", "/")}`;
	}
	return normalized.startsWith("\\\\")
		? normalized.replaceAll("\\", "/")
		: normalized;
}

export function findReusableChatRuntime(
	states: readonly ChatSessionRuntimeState[],
	projectId: string,
	sessionPath: string,
): ChatSessionRuntimeState | null {
	const pathKey = runtimeSessionPathKey(sessionPath);
	return (
		states.find(
			(state) =>
				state.projectId === projectId &&
				typeof state.sessionPath === "string" &&
				runtimeSessionPathKey(state.sessionPath) === pathKey &&
				(state.snapshot.state === "running" ||
					state.snapshot.state === "starting"),
		) ?? null
	);
}

export function runtimeSessionIdFromKey(
	sessionKey: string,
	projectId: string,
): string | null {
	try {
		const parsed = JSON.parse(sessionKey) as unknown;
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			parsed[0] === projectId &&
			typeof parsed[1] === "string" &&
			parsed[1].length > 0
		) {
			return parsed[1];
		}
	} catch {
		// Non-standard keys cannot be represented by ChatPage's project/session id pair.
	}
	return null;
}
