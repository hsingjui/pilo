import { userErrorMessage } from "@shared/app-error";

export * from "@shared/api/pi-runtime-types";

// Prompt preflight may include compaction or extension hooks.
export const PI_PROMPT_RPC_TIMEOUT_MS = 120_000;

export function runtimeErrorMessage(error: unknown): string {
	return userErrorMessage(error);
}
