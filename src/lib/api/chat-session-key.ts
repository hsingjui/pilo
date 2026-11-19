export function chatSessionKey(projectId: string, sessionId: string) {
	return JSON.stringify([projectId, sessionId]);
}
