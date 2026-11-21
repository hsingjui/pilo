export type CacheKeepAliveSettings = {
	connectionId: string;
	provider: string;
	modelId: string;
	enabled: boolean;
	cacheTtlSeconds: number;
	idleKeepAliveSeconds: number;
	updatedAtMs: number;
};

export type CacheKeepAliveStatus = {
	ready: boolean;
	status: "scheduled" | "warming" | "stopped" | "unavailable";
	reason: string;
	provider: string | null;
	modelId: string | null;
	expiresAtMs: number;
	nextWarmAtMs: number | null;
	requestCount: number;
	inputTokens?: number | null;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	cost: number | null;
};

export function cacheKeepAliveHitRate(
	status: Pick<
		CacheKeepAliveStatus,
		"inputTokens" | "cacheReadTokens" | "cacheWriteTokens"
	>,
): number | null {
	if (status.inputTokens == null) return null;
	const total =
		status.inputTokens + status.cacheReadTokens + status.cacheWriteTokens;
	return total > 0 ? status.cacheReadTokens / total : null;
}

export function defaultCacheKeepAliveSettings(
	connectionId: string,
	provider: string,
	modelId: string,
): CacheKeepAliveSettings {
	return {
		connectionId,
		provider,
		modelId,
		enabled: false,
		cacheTtlSeconds: 300,
		idleKeepAliveSeconds: 30 * 60,
		updatedAtMs: 0,
	};
}
