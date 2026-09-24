import type { ChatSessionRuntimeState } from "@/lib/chat-session-client";
import type { PiSessionSnapshot, PiloRuntimeEvent } from "@/lib/pi-runtime";
import type { Project } from "@/lib/projects";
import type {
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/sessions";

export type PiloClientBootstrap = {
	projects: Project[];
	chatSessions: ChatSessionRuntimeState[];
	latestSequence: number;
};

export type PiloClientStartChatInput = {
	projectId: string;
	sessionKey: string;
	sessionPath?: string;
	noSession?: boolean;
};

export type PiloClientHistoryOptions = {
	startMessage?: number;
	messageLimit?: number;
	includeMessageIndex?: boolean;
	fingerprint?: SessionHistoryFingerprint;
};

export type PiloClientEvent = PiloRuntimeEvent & { sequence: number };

export type PiloClientEventMessage =
	| { type: "hello"; latestSequence: number; deviceId?: string }
	| { type: "events"; events: PiloClientEvent[] }
	| { type: "resyncRequired"; latestSequence: number };

export type PiloClientEventOptions = {
	after?: number;
	onMessage: (message: PiloClientEventMessage) => void;
	onStatus: (connected: boolean) => void;
};

export interface PiloClient {
	bootstrap(): Promise<PiloClientBootstrap>;
	listSessions(projectId: string): Promise<SessionIndexEntry[]>;
	loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult>;
	readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	): Promise<Uint8Array<ArrayBuffer>>;
	generateSessionTitle(
		projectId: string,
		message: string,
	): Promise<string | null>;
	startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot>;
	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null>;
	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void>;
	connectEvents(options: PiloClientEventOptions): Promise<() => void>;
}
