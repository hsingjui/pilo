import type { AppError } from "@shared/app-error";

export type ChatRuntimeRecoveryMessageKey =
	| ""
	| "chat.temporaryNotRecoverable"
	| "chat.reconnecting"
	| "chat.runtimeReconnectRequired"
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
