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

/** Null means hidden indefinitely; a positive delay only needs a local timer. */
export function cacheKeepAliveNoticeDelay(
	status: CacheKeepAliveStatus | null,
	now: number,
): number | null {
	if (
		!status ||
		["disabled", "waiting_request", "running", "context_changed"].includes(
			status.reason,
		)
	)
		return null;
	if (status.status !== "scheduled") return 0;
	return status.nextWarmAtMs == null
		? null
		: Math.max(0, status.nextWarmAtMs - now - 30_000);
}

export function cacheKeepAliveStatusMessage(status: CacheKeepAliveStatus) {
	if (!status.ready) return "settings.cacheKeepAliveUnsupported";
	switch (status.reason) {
		case "warmed":
			return "settings.cacheKeepAliveWarmed";
		case "scheduled":
			return "settings.cacheKeepAliveScheduled";
		case "window_ending":
			return "settings.cacheKeepAliveWindowEnding";
		case "warming":
			return "settings.cacheKeepAliveWarming";
		case "cache_expired":
			return "settings.cacheKeepAliveExpired";
		case "window_ended":
			return "settings.cacheKeepAliveWindowEnded";
		case "cache_miss":
			return "settings.cacheKeepAliveMiss";
		case "unsupported_request":
			return "settings.cacheKeepAliveUnsupported";
		case "timeout":
		case "request_failed":
			return "settings.cacheKeepAliveFailed";
		case "running":
			return "settings.cacheKeepAliveRunning";
		case "disabled":
			return "settings.cacheKeepAliveDisabled";
		default:
			return "settings.cacheKeepAliveWaiting";
	}
}

export function cacheKeepAliveUsage(
	status: CacheKeepAliveStatus,
	locale: string,
) {
	const hitRate = cacheKeepAliveHitRate(status);
	return {
		count: status.requestCount,
		hitRate:
			hitRate === null
				? "—"
				: new Intl.NumberFormat(locale, {
						style: "percent",
						maximumFractionDigits: 1,
					}).format(hitRate),
		cost: status.cost === null ? "—" : `$${status.cost.toFixed(6)}`,
	};
}
