import type { PiModel, PiThinkingLevel } from "@/lib/api/pi-runtime";
import type { Project } from "@/lib/api/projects";

export { formatTime } from "@shared/chat/format-time";
export type { ChatSessionRuntimeState } from "@shared/chat/session-stats";

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
