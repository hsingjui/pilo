import { userErrorMessage } from "@/lib/app-error";

export * from "./pi-runtime-types";

// Prompt preflight may include compaction or extension hooks.
export const PI_PROMPT_RPC_TIMEOUT_MS = 120_000;

export function runtimeErrorMessage(error: unknown): string {
	return userErrorMessage(error);
}
