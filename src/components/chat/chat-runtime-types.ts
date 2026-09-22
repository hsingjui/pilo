import type { MutableRefObject } from "react";

import type { AppError } from "@/lib/app-error";
import type { createChatSessionClient } from "@/lib/chat-session-client";
import type { ChatSubmission } from "@/lib/chat-submission";

export type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

export type ActiveTurn = {
	sessionId: string;
	sessionTitle: string;
	projectId: string;
	notificationSessionId: string;
	generation: number | null;
	promptSent: boolean;
	queueReady: boolean;
	preserveQueuedOnRelease: boolean;
};

export type ChatRuntimeRecoveryMessageKey =
	| ""
	| "chat.temporaryNotRecoverable"
	| "chat.reconnecting"
	| "chat.reconnected"
	| "chat.reconnectedActive"
	| "chat.piProcessFailed"
	| "chat.piProcessStopped";

export type ChatRuntimeRecoveryState =
	| { status: "idle"; recoverable: boolean; messageKey: "" }
	| {
			status: "reconnecting";
			recoverable: true;
			messageKey: "chat.reconnecting";
	  }
	| {
			status: "recovered";
			recoverable: true;
			messageKey: "chat.reconnected" | "chat.reconnectedActive";
	  }
	| {
			status: "failed";
			recoverable: boolean;
			messageKey: ChatRuntimeRecoveryMessageKey;
			error?: AppError;
	  };

export type BufferedQueuedMessage = {
	turn: ActiveTurn;
	clientMessageId: string;
	submission: ChatSubmission;
	queued: "steer" | "follow_up";
	timestampMs: number;
};

export type BeginTurn = (
	submission: ChatSubmission,
	appendUserMessage?: boolean,
) => Promise<void>;

export type BeginTurnRef = MutableRefObject<BeginTurn | null>;
