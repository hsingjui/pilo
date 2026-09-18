/**
 * Source of a tiny Pi extension Pilo loads into its throwaway model-probe
 * session (pi --mode rpc --extension <tempfile>) to resolve the whole model
 * catalog in one round trip.
 *
 * The handler runs inside Pi, so it can use Pi's own resolution logic instead
 * of reproducing it over RPC: ctx.modelRegistry.getAvailable() matches the
 * get_available_models RPC payload, ctx.scopedModels is the scoped-model cycle
 * state, and pi.setModel() applies Pi's per-model thinking-level resolution
 * (per-model override > global default > current level, clamped) in process.
 * The result is handed back through the extension UI bridge: Pilo answers the
 * blocking confirm request and the catalog rides in its message field.
 *
 * Keep this plain ESM JavaScript — jiti loads it inside Pi verbatim.
 */
export const PI_MODEL_CATALOG_COMMAND = "/pilo_model_catalog";

/** Title Pilo matches on the extension_ui_request carrying the catalog. */
export const PI_MODEL_CATALOG_TITLE = "pilo-model-catalog:v1";

export const PI_MODEL_CATALOG_EXTENSION_SOURCE = `
const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedThinkingLevels(model) {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = map ? map[level] : undefined;
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function modelKey(model) {
	return model ? model.provider + "\\u0000" + model.id : null;
}

export default function (pi) {
	pi.registerCommand("pilo_model_catalog", {
		description: "Pilo model catalog probe",
		handler: async (_args, ctx) => {
			try {
				const models = ctx.modelRegistry.getAvailable();
				const baselineModel = ctx.model;
				const baselineThinkingLevel = ctx.thinkingLevel;
				const defaults = new Map();
				if (baselineModel) {
					for (const model of models) {
						try {
							await pi.setModel(baselineModel);
							pi.setThinkingLevel(baselineThinkingLevel);
							if (modelKey(model) !== modelKey(baselineModel)) {
								await pi.setModel(model);
							}
							defaults.set(modelKey(model), pi.getThinkingLevel());
						} catch (error) {
							// Leave the default unresolved; Pilo falls back per model.
						}
					}
					try {
						await pi.setModel(baselineModel);
						pi.setThinkingLevel(baselineThinkingLevel);
					} catch (error) {
						// Best-effort restore on a throwaway probe session.
					}
				}
				const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels : [];
				const scopedKeys = scoped.map((entry) => modelKey(entry.model));
				const baselineIndex = scopedKeys.indexOf(modelKey(baselineModel));
				const orderedKeys =
					baselineIndex > 0
						? scopedKeys.slice(baselineIndex).concat(scopedKeys.slice(0, baselineIndex))
						: scopedKeys;
				const catalog = models.map((model) => {
					const key = modelKey(model);
					const scopedIndex = orderedKeys.indexOf(key);
					const scopedEntry = scopedIndex === -1 ? null : scoped[scopedKeys.indexOf(key)];
					return {
						...model,
						thinkingLevels: supportedThinkingLevels(model),
						defaultThinkingLevel: defaults.has(key) ? defaults.get(key) : null,
						scopeOrder: scopedIndex === -1 ? null : scopedIndex,
						scopeThinkingLevel:
							scopedEntry && scopedEntry.thinkingLevel !== undefined
								? scopedEntry.thinkingLevel
								: null,
					};
				});
				await ctx.ui.confirm(
					"${PI_MODEL_CATALOG_TITLE}",
					JSON.stringify({
						models: catalog,
						baselineModel,
						baselineThinkingLevel,
					}),
				);
			} catch (error) {
				await ctx.ui.confirm(
					"pilo-model-catalog:error",
					String(error && error.message ? error.message : error),
				);
			}
		},
	});
}
`;
