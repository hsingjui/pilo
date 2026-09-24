import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import type { PiSessionStats } from "@/lib/pi-runtime";

function isKnownContextValue(value: number | null | undefined) {
	return typeof value === "number" && Number.isFinite(value);
}

export function mergeRefreshedSessionState(
	previous: ChatSessionRuntimeState | null,
	state: ChatSessionRuntimeState,
) {
	// Pi 在压缩后到下一次模型响应前会返回未知的 contextUsage。保留上一次
	// 已知占用并标记为待更新，避免占用指示器退化成未知/加载状态。
	const contextUnknown =
		!isKnownContextValue(state.contextPercent) &&
		!isKnownContextValue(state.contextTokens);
	if (
		!contextUnknown ||
		!previous ||
		!isKnownContextValue(previous.contextPercent)
	) {
		return { ...state, contextStale: false };
	}
	return {
		...state,
		contextTokens: previous.contextTokens,
		contextPercent: previous.contextPercent,
		contextWindow: state.contextWindow ?? previous.contextWindow,
		contextStale: true,
	};
}

export function mergeSessionStats(
	previous: ChatSessionRuntimeState | null,
	stats: PiSessionStats,
) {
	return mergeRefreshedSessionState(previous, {
		...previous,
		tokens: stats.tokens,
		cost: stats.cost,
		contextTokens: stats.contextUsage?.tokens,
		contextWindow: stats.contextUsage?.contextWindow,
		contextPercent: stats.contextUsage?.percent,
	});
}
