import type { PiloRuntimeEvent } from "@shared/api/pi-runtime-types";
import type { NextPromptRequest, NextPromptResult } from "./next-prompt-types";

export type {
	NextPromptModel,
	NextPromptRequest,
	NextPromptResult,
	NextPromptSettings,
} from "./next-prompt-types";

export function traceNextPrompt(
	stage: string,
	detail: Partial<NextPromptRequest> & {
		reason?: string;
		status?: NextPromptResult["status"];
		elapsedMs?: number;
	},
) {
	// Only correlation/state metadata; never pass a result, draft or raw error.
	const payload = JSON.stringify({
		stage: `next_prompt.client.${stage}`,
		sessionKey: detail.sessionKey,
		requestId: detail.requestId,
		generation: detail.generation,
		revision: detail.revision,
		reason: detail.reason,
		status: detail.status,
		elapsedMs: detail.elapsedMs,
	});
	console.info("[next-prompt]", payload);
}

export function decodeNextPromptResult(
	event: PiloRuntimeEvent,
): NextPromptResult | null {
	if (
		event.type !== "extension_ui_request" ||
		event.method !== "setWidget" ||
		event.widgetKey !== "pilo.next-prompt.v1" ||
		event.widgetLines?.length !== 1
	)
		return null;
	const line = event.widgetLines[0];
	if (line.length > 4096) return null;
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object") return null;
		const result = value as Record<string, unknown>;
		if (
			typeof result.requestId !== "string" ||
			result.requestId.length > 128 ||
			typeof result.sessionId !== "string" ||
			result.sessionId.length > 256 ||
			!(result.leafId === null || typeof result.leafId === "string") ||
			typeof result.revision !== "number" ||
			!Number.isSafeInteger(result.revision) ||
			result.revision < 0 ||
			!(
				result.text === null ||
				(typeof result.text === "string" &&
					result.text.length > 0 &&
					result.text.length <= 160 &&
					!/[\r\n`]/u.test(result.text))
			) ||
			!(
				result.status === "ready" ||
				result.status === "empty" ||
				result.status === "cancelled" ||
				result.status === "unavailable"
			)
		)
			return null;
		return {
			requestId: result.requestId,
			sessionId: result.sessionId,
			leafId: result.leafId,
			revision: result.revision,
			text: result.text,
			status: result.status,
		};
	} catch {
		return null;
	}
}
