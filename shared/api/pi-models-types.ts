import type { PiCommand, PiModel, PiThinkingLevel } from "./pi-runtime-types";

export type ProjectPiModels = {
	projectId: string;
	models: PiModel[];
	commands: PiCommand[] | null;
	defaultModel: PiModel | null;
	defaultThinkingLevel: PiThinkingLevel | null;
	refreshedAtMs: number;
};
