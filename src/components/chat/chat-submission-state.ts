export type ChatLoadState = "ready" | "loading" | "error";

export function routeInitialDeferredSubmissions(
	sessionPath: string | undefined,
	submissions: readonly string[],
) {
	const queued = [...submissions];
	return sessionPath
		? { runtime: [] as string[], history: queued }
		: { runtime: queued, history: [] as string[] };
}

export function shouldDeferSubmissionUntilHistoryReady(
	sessionPath: string | undefined,
	loadState: ChatLoadState,
) {
	return Boolean(sessionPath) && loadState !== "ready";
}
