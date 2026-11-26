import { formatCost } from "./format-numbers";

export const CACHE_KEEP_ALIVE_SUPPORTED_APIS = [
	"anthropic-messages",
	"openai-responses",
	"openai-responses-ws",
	"openai-completions",
] as const;

export type CacheKeepAliveSupportedApi =
	(typeof CACHE_KEEP_ALIVE_SUPPORTED_APIS)[number];

/** 仅扩展实际支持重放的 API 才允许启用缓存保活；未知（旧版目录未带 api 字段）时保守放行。 */
export function isCacheKeepAliveSupportedApi(
	api: string | null | undefined,
): boolean {
	if (!api) return true;
	return (CACHE_KEEP_ALIVE_SUPPORTED_APIS as readonly string[]).includes(api);
}

/** 默认 Prompt Cache 有效时长（秒）。 */
export const DEFAULT_CACHE_TTL_SECONDS = 300;

/** 按服务商/API 预设常见缓存有效时长（秒），减少用户手动查文档填参的负担。 */
export function recommendedCacheTtlSeconds(
	_provider: string,
	_api?: string | null,
): number {
	return DEFAULT_CACHE_TTL_SECONDS;
}

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
	api?: string | null,
): CacheKeepAliveSettings {
	return {
		connectionId,
		provider,
		modelId,
		enabled: false,
		cacheTtlSeconds: recommendedCacheTtlSeconds(provider, api),
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
		[
			"disabled",
			"paused",
			"waiting_request",
			"running",
			"context_changed",
		].includes(status.reason)
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
		case "paused":
			return "settings.cacheKeepAlivePaused";
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
		cost: status.cost === null ? "—" : formatCost(status.cost),
	};
}
