export type ComposerSendMode = "steer" | "follow_up" | "send_now";

export const COMPOSER_SEND_MODE_STORAGE_KEY = "pilo.composerSendMode.v1";
export const DEFAULT_COMPOSER_SEND_MODE: ComposerSendMode = "steer";

export function isComposerSendMode(value: unknown): value is ComposerSendMode {
	return value === "steer" || value === "follow_up" || value === "send_now";
}
