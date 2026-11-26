export function chatSessionKey(projectId: string, sessionId: string) {
	return JSON.stringify([projectId, sessionId]);
}

export function parseChatSessionKey(
	sessionKey: string,
): [projectId: string, sessionId: string] | null {
	try {
		const parsed: unknown = JSON.parse(sessionKey);
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		) {
			return [parsed[0], parsed[1]];
		}
	} catch {
		return null;
	}
	return null;
}
