export type PersistedComposerSendMode = "steer" | "follow_up";
export type ComposerSendMode = PersistedComposerSendMode | "send_now";

export const COMPOSER_SEND_MODE_STORAGE_KEY = "pilo.composerSendMode.v1";
export const DEFAULT_COMPOSER_SEND_MODE: PersistedComposerSendMode = "steer";

export function isPersistedComposerSendMode(
	value: unknown,
): value is PersistedComposerSendMode {
	return value === "steer" || value === "follow_up";
}

export function isComposerSendMode(value: unknown): value is ComposerSendMode {
	return isPersistedComposerSendMode(value) || value === "send_now";
}
