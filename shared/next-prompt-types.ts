export type NextPromptModel = { provider: string; id: string };
export type NextPromptSettings = {
	connectionId: string;
	enabled: boolean;
	model: NextPromptModel | null;
	updatedAtMs: number;
};
export type NextPromptRequest = {
	sessionKey: string;
	sessionId: string;
	requestId: string;
	generation: number;
	revision: number;
	cancel?: boolean;
};
export type NextPromptResult = {
	requestId: string;
	sessionId: string;
	leafId: string | null;
	revision: number;
	text: string | null;
	status: "ready" | "empty" | "cancelled" | "unavailable";
};
