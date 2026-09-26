import type { ChatSessionRuntimeState } from "@/lib/chat-session-client";

export function findReusableChatRuntime(
	states: readonly ChatSessionRuntimeState[],
	projectId: string,
	sessionPath: string,
): ChatSessionRuntimeState | null {
	return (
		states.find(
			(state) =>
				state.projectId === projectId &&
				state.sessionPath === sessionPath &&
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
