import { createChatSessionClient } from "@/lib/chat-session-client";
import type { PiAgentState, PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import type { Project } from "@/lib/projects";

export type ChatSession = {
	id: string;
	title: string;
	projectRecord: Project;
	sessionPath?: string;
	historyFileSize?: number;
	historyFileMtimeNs?: string;
	initialModel?: PiModel;
	initialThinkingLevel?: PiThinkingLevel;
};

export type ChatSessionRuntimeState = {
	name?: string;
	messageCount?: number;
	tokens?: number;
	cost?: number;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
};

export async function readCurrentPiSessionState(
	client: ReturnType<typeof createChatSessionClient>,
	agentState?: PiAgentState,
): Promise<ChatSessionRuntimeState> {
	const [state, stats] = await Promise.all([
		agentState ?? client.getPiAgentState(),
		client.getPiSessionStats(),
	]);
	return {
		name: state.sessionName,
		messageCount: state.messageCount,
		tokens: stats.tokens?.total,
		cost: stats.cost,
		contextTokens: stats.contextUsage?.tokens,
		contextWindow: stats.contextUsage?.contextWindow,
		contextPercent: stats.contextUsage?.percent,
	};
}

const compactNumberFormatter = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

export function formatSessionUsage(
	state: ChatSessionRuntimeState | null,
): string {
	if (!state) return "";
	const parts: string[] = [];
	if (state.contextPercent !== null && state.contextPercent !== undefined) {
		parts.push(`${Math.round(state.contextPercent)}% 上下文`);
	} else if (
		state.contextTokens !== null &&
		state.contextTokens !== undefined &&
		state.contextWindow
	) {
		parts.push(
			`${compactNumberFormatter.format(state.contextTokens)}/${compactNumberFormatter.format(state.contextWindow)} 上下文`,
		);
	}
	if (state.tokens !== undefined) {
		parts.push(`${compactNumberFormatter.format(state.tokens)} tokens`);
	}
	if (state.cost !== undefined) {
		parts.push(
			`$${state.cost < 0.01 ? state.cost.toFixed(4) : state.cost.toFixed(2)}`,
		);
	}
	return parts.join(" · ");
}

export function formatTime(timestampMs = Date.now()) {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(timestampMs));
}

export function getSessionHistoryFingerprint(session: ChatSession) {
	if (
		!session.sessionPath ||
		session.historyFileSize === undefined ||
		session.historyFileMtimeNs === undefined
	) {
		return null;
	}
	return `${session.historyFileSize}:${session.historyFileMtimeNs}`;
}
