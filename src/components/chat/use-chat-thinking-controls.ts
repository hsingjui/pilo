import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { createChatSessionClient } from "@/lib/chat-session-client";
import { getPiModelThinkingLevels } from "@/lib/pi-model-selection";
import {
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

type UseChatThinkingControlsOptions = {
	client: ChatSessionClient;
	sessionPath: string | undefined;
	selectedModel: PiModel | null;
	selectedThinkingLevel: PiThinkingLevel;
	thinkingLevels: PiThinkingLevel[];
	thinkingSelectionDirtyRef: MutableRefObject<boolean>;
	setSelectedThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel>>;
	setThinkingLevels: Dispatch<SetStateAction<PiThinkingLevel[]>>;
};

export function useChatThinkingControls({
	client,
	sessionPath,
	selectedModel,
	selectedThinkingLevel,
	thinkingLevels,
	thinkingSelectionDirtyRef,
	setSelectedThinkingLevel,
	setThinkingLevels,
}: UseChatThinkingControlsOptions) {
	const { t } = useTranslation();
	const [thinkingLoading, setThinkingLoading] = useState(false);
	const [thinkingChanging, setThinkingChanging] = useState(false);

	const loadThinkingLevels = useCallback(async () => {
		if (thinkingLoading || thinkingChanging) return;
		if (sessionPath) {
			setThinkingLevels([...getPiModelThinkingLevels(selectedModel)]);
			return;
		}
		setThinkingLoading(true);
		try {
			await client.ensure();
			const [levels, state] = await Promise.all([
				client.getAvailablePiThinkingLevels(),
				client.getPiAgentState(),
			]);
			setThinkingLevels(levels.levels);
			setSelectedThinkingLevel(state.thinkingLevel);
		} catch (error) {
			toast.error(t("chat.readReasoningFailed"), {
				description: runtimeErrorMessage(error),
			});
		} finally {
			setThinkingLoading(false);
		}
	}, [
		client,
		selectedModel,
		sessionPath,
		setSelectedThinkingLevel,
		setThinkingLevels,
		thinkingChanging,
		thinkingLoading,
		t,
	]);

	const handleThinkingChange = useCallback(
		(level: PiThinkingLevel | null) => {
			if (
				!level ||
				thinkingChanging ||
				level === selectedThinkingLevel ||
				!thinkingLevels.includes(level)
			)
				return;
			thinkingSelectionDirtyRef.current = true;
			if (sessionPath) {
				setSelectedThinkingLevel(level);
				return;
			}
			const previous = selectedThinkingLevel;
			setSelectedThinkingLevel(level);
			setThinkingChanging(true);
			void (async () => {
				try {
					await client.ensure();
					await client.setPiThinkingLevel(level);
					const state = await client.getPiAgentState();
					setSelectedThinkingLevel(state.thinkingLevel);
				} catch (error) {
					setSelectedThinkingLevel(previous);
					toast.error(t("chat.reasoningSwitchFailed"), {
						description: runtimeErrorMessage(error),
					});
				} finally {
					setThinkingChanging(false);
				}
			})();
		},
		[
			client,
			selectedThinkingLevel,
			sessionPath,
			setSelectedThinkingLevel,
			thinkingChanging,
			thinkingLevels,
			thinkingSelectionDirtyRef,
			t,
		],
	);

	return {
		thinkingLoading,
		thinkingChanging,
		loadThinkingLevels,
		handleThinkingChange,
	};
}
