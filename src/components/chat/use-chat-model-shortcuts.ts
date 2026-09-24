import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import type { PiModel } from "@/lib/pi-runtime";

/**
 * Model-switching keyboard shortcuts for the active chat: the plain "cycle
 * model" cycle and the scoped quick-cycle. Both stay inert while the runtime is
 * busy or history is still loading so they never race a pending selection.
 */
export function useChatModelShortcuts({
	active,
	cycleModelShortcut,
	cycleScopedModelShortcut,
	modelOptions,
	selectedModel,
	modelChanging,
	modelLoadState,
	runtimeBusy,
	historyPending,
	loadModelOptions,
	handleModelChange,
	handleQuickCycleModel,
}: {
	active: boolean;
	cycleModelShortcut: string;
	cycleScopedModelShortcut: string;
	modelOptions: readonly PiModel[];
	selectedModel: PiModel | null;
	modelChanging: boolean;
	modelLoadState: "idle" | "loading" | "ready" | "error";
	runtimeBusy: boolean;
	historyPending: boolean;
	loadModelOptions: (force?: boolean) => Promise<void>;
	handleModelChange: (model: PiModel | null) => void;
	handleQuickCycleModel: () => void;
}) {
	const enabled =
		active &&
		!modelChanging &&
		modelLoadState !== "loading" &&
		!runtimeBusy &&
		!historyPending;
	useKeyboardShortcut(
		cycleModelShortcut,
		() => {
			if (modelOptions.length === 0) {
				void loadModelOptions();
				return;
			}
			const currentIndex = selectedModel
				? modelOptions.findIndex(
						(model) =>
							model.provider === selectedModel.provider &&
							model.id === selectedModel.id,
					)
				: -1;
			const nextModel = modelOptions[(currentIndex + 1) % modelOptions.length];
			if (nextModel) handleModelChange(nextModel);
		},
		{ enabled },
	);
	useKeyboardShortcut(cycleScopedModelShortcut, handleQuickCycleModel, {
		enabled,
	});
}
