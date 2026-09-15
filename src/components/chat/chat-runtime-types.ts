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

export type ChatRuntimeRecoveryState =
	| { status: "idle"; recoverable: boolean; message: string }
	| { status: "reconnecting"; recoverable: true; message: string }
	| { status: "recovered"; recoverable: true; message: string }
	| {
			status: "failed";
			recoverable: boolean;
			message: string;
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
