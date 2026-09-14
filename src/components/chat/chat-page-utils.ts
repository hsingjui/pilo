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
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	toolResults?: number;
	totalMessages?: number;
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
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
		userMessages: stats.userMessages,
		assistantMessages: stats.assistantMessages,
		toolCalls: stats.toolCalls,
		toolResults: stats.toolResults,
		totalMessages: stats.totalMessages,
		tokens: stats.tokens,
		cost: stats.cost,
		contextTokens: stats.contextUsage?.tokens,
		contextWindow: stats.contextUsage?.contextWindow,
		contextPercent: stats.contextUsage?.percent,
	};
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
