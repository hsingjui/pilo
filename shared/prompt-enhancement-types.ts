/**
 * A model reference for one composer rewrite.
 *
 * `null` on the settings means "follow the chat model": the Host then runs the
 * rewrite with the model the composer has selected.
 */
export type PromptEnhancementModel = {
	provider: string;
	id: string;
};

/**
 * Per-Connection prompt enhancement settings, stored by the Host.
 *
 * Disabled by default, and shared by the desktop app and the Remote WebUI on
 * the same Connection. Disabling keeps the selected model.
 */
export type PromptEnhancementSettings = {
	connectionId: string;
	enabled: boolean;
	model: PromptEnhancementModel | null;
	updatedAtMs: number;
};
