import type { PiModel } from "@shared/api/pi-runtime-types";
import type { PromptEnhancementModel } from "@shared/prompt-enhancement-types";

export type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@shared/prompt-enhancement-types";

/** Normalize a chat model selection into the Host's enhancement model shape. */
export function promptEnhancementModel(
	model: Pick<PiModel, "provider" | "id"> | null | undefined,
): PromptEnhancementModel | null {
	if (!model) return null;
	const provider = model.provider?.trim();
	const id = model.id?.trim();
	if (!provider || !id) return null;
	return { provider, id };
}
