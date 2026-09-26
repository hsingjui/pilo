import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";

import type { ChatSession } from "@/components/chat/chat-page-utils";
import type { createChatSessionClient } from "@/lib/chat-session-client";
import type { PiAgentState, PiModel, PiThinkingLevel } from "@/lib/pi-runtime";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

type UseChatRuntimeConfigurationOptions = {
	session: ChatSession;
	client: ChatSessionClient;
	selectedModel: PiModel | null;
	selectedThinkingLevel: PiThinkingLevel;
	setSelectedModel: Dispatch<SetStateAction<PiModel | null>>;
	setSelectedThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel>>;
	setThinkingLevels: Dispatch<SetStateAction<PiThinkingLevel[]>>;
};

export function useChatRuntimeConfiguration({
	session,
	client,
	selectedModel,
	selectedThinkingLevel,
	setSelectedModel,
	setSelectedThinkingLevel,
	setThinkingLevels,
}: UseChatRuntimeConfigurationOptions) {
	const initialConfigAppliedRef = useRef(new Set<string>());

	return useCallback(
		async (agentState: PiAgentState) => {
			if (session.sessionPath) {
				let configChanged = false;
				if (
					selectedModel &&
					(agentState.model?.provider !== selectedModel.provider ||
						agentState.model?.id !== selectedModel.id)
				) {
					await client.setPiModel(selectedModel);
					configChanged = true;
				}
				if (agentState.thinkingLevel !== selectedThinkingLevel) {
					await client.setPiThinkingLevel(selectedThinkingLevel);
					configChanged = true;
				}
				if (configChanged) {
					const [state, thinking] = await Promise.all([
						client.getPiAgentState(),
						client.getAvailablePiThinkingLevels(),
					]);
					setSelectedModel(state.model);
					setSelectedThinkingLevel(state.thinkingLevel);
					setThinkingLevels(thinking.levels);
				}
				return;
			}

			if (initialConfigAppliedRef.current.has(session.id)) return;
			let configChanged = false;
			if (
				session.initialModel &&
				(agentState.model?.provider !== session.initialModel.provider ||
					agentState.model?.id !== session.initialModel.id)
			) {
				await client.setPiModel(session.initialModel);
				configChanged = true;
			}
			if (
				session.initialThinkingLevel &&
				agentState.thinkingLevel !== session.initialThinkingLevel
			) {
				await client.setPiThinkingLevel(session.initialThinkingLevel);
				configChanged = true;
			}
			if (configChanged) {
				const [state, thinking] = await Promise.all([
					client.getPiAgentState(),
					client.getAvailablePiThinkingLevels(),
				]);
				setSelectedModel(state.model);
				setSelectedThinkingLevel(state.thinkingLevel);
				setThinkingLevels(thinking.levels);
			}
			initialConfigAppliedRef.current.add(session.id);
		},
		[
			client,
			selectedModel,
			selectedThinkingLevel,
			session.id,
			session.initialModel,
			session.initialThinkingLevel,
			session.sessionPath,
			setSelectedModel,
			setSelectedThinkingLevel,
			setThinkingLevels,
		],
	);
}
