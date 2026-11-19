import type { ConversationEvent } from "@/lib/chat/conversation-types";

export type SessionExternalActivity = {
	path: string;
	turnOpen: boolean;
};

export type SessionIndexEntry = {
	connectionId: string;
	projectId: string;
	piSessionId: string;
	sessionPath: string;
	name: string | null;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	lastMessageAt: string | null;
	firstUserMessagePreview: string | null;
	fileSize: number;
	fileMtimeNs: string;
	lastOffset: number;
	indexedAtMs: number;
	pinned: boolean;
	titleOverride: string | null;
};

export type SessionSearchMatch = {
	sessionPath: string;
	sessionId: string;
	role: "user" | "assistant";
	snippet: string;
	timestamp: string | number | null;
};

export type SessionHistoryMessageIndexEntry = {
	id: string;
	role: "user" | "assistant" | "compaction";
	timestampMs?: number;
	preview: string;
	estimatedChars: number;
};

export type SessionHistory = {
	events: ConversationEvent[];
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	name: string | null;
	headerMissing?: boolean;
	sourceMessageCount: number;
	windowStartMessage?: number;
	windowMessageCount?: number;
	totalMessages?: number;
	messageIndex?: SessionHistoryMessageIndexEntry[];
	stats?: {
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
		toolResults: number;
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextTokens: number | null;
	};
};

export type SessionHistoryFingerprint = {
	fileSize: number;
	fileMtimeNs: string;
};

export type SessionDeleteResult = {
	method: "trash" | "unlink";
};

export type SessionHistoryResult = {
	history: SessionHistory;
	fingerprint: SessionHistoryFingerprint | null;
};
