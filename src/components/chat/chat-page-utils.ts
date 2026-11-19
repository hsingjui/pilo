import { createChatSessionClient } from "@/lib/api/chat-session-client";
import type {
	PiAgentState,
	PiModel,
	PiThinkingLevel,
} from "@/lib/api/pi-runtime";
import type { Project } from "@/lib/api/projects";

export { formatTime } from "@/lib/chat/format-time";

export type ChatSession = {
	id: string;
	title: string;
	projectRecord: Project;
	temporary?: boolean;
	sessionPath?: string;
	historyFileSize?: number;
	historyFileMtimeNs?: string;
	externalRunning?: boolean;
	externalTurnOpen?: boolean;
	initialModel?: PiModel;
	initialThinkingLevel?: PiThinkingLevel;
};

export type ChatSessionRuntimeState = {
	sessionId?: string;
	sessionPath?: string;
	name?: string;
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	cost?: number;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
	/** Pi 在压缩后暂时不返回占用，此时保留上一次已知值并置为 true。 */
	contextStale?: boolean;
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
		sessionId: state.sessionId,
		sessionPath: state.sessionFile,
		name: state.sessionName,
		tokens: stats.tokens,
		cost: stats.cost,
		contextTokens: stats.contextUsage?.tokens,
		contextWindow: stats.contextUsage?.contextWindow,
		contextPercent: stats.contextUsage?.percent,
	};
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
