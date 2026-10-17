import type { PiModel } from "@/lib/api/pi-runtime";

/**
 * One composer-prompt rewrite.
 *
 * The Host runs it on a throwaway Pi process with the chat's current model, so
 * it never joins a conversation and stays available while a turn is running.
 * Desktop and WebUI share this shape; the transport lives in each Pilo client.
 */
export type PromptEnhanceModel = {
	provider: string;
	id: string;
};

export function promptEnhanceModel(
	model: Pick<PiModel, "provider" | "id"> | null | undefined,
): PromptEnhanceModel | null {
	if (!model) return null;
	const provider = model.provider?.trim();
	const id = model.id?.trim();
	if (!provider || !id) return null;
	return { provider, id };
}
