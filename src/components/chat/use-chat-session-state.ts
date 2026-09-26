import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import {
	mergeRefreshedSessionState,
	mergeSessionStats,
} from "@/components/chat/chat-session-config-model";
import {
	readCurrentPiSessionState,
	type ChatSession,
	type ChatSessionRuntimeState,
} from "@/components/chat/chat-page-utils";
import type { createChatSessionClient } from "@/lib/chat-session-client";
import { getCachedProjectPiModels } from "@/lib/pi-models";
import {
	findMatchingPiModel,
	getPiModelThinkingLevels,
} from "@/lib/pi-model-selection";
import {
	PI_THINKING_LEVELS,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";
import type { SessionHistory } from "@/lib/sessions";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

type UseChatSessionStateOptions = {
	session: ChatSession;
	client: ChatSessionClient;
	setSelectedModel: Dispatch<SetStateAction<PiModel | null>>;
	setSelectedThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel>>;
	setThinkingLevels: Dispatch<SetStateAction<PiThinkingLevel[]>>;
};

export function useChatSessionState({
	session,
	client,
	setSelectedModel,
	setSelectedThinkingLevel,
	setThinkingLevels,
}: UseChatSessionStateOptions) {
	const [sessionState, setSessionState] =
		useState<ChatSessionRuntimeState | null>(null);
	const sessionStateRequestRef = useRef(0);
	const sessionStateAppliedRef = useRef(0);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Session identity/config changes intentionally invalidate the displayed runtime state even when those values are only trigger keys. */
	useEffect(() => {
		void session.id;
		const requestGeneration = ++sessionStateRequestRef.current;
		sessionStateAppliedRef.current = requestGeneration;
		setSessionState(null);
	}, [
		session.id,
		session.initialModel,
		session.initialThinkingLevel,
		session.projectRecord.id,
		session.sessionPath,
	]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	const applyHistoryMetadata = useCallback(
		(result: SessionHistory) => {
			const cachedModels =
				getCachedProjectPiModels(session.projectRecord.id)?.models ?? [];
			let historicalModel: PiModel | null = null;
			if (result.model) {
				historicalModel = findMatchingPiModel(cachedModels, result.model) ?? {
					provider: result.model.provider,
					id: result.model.id,
					name: result.model.id,
					reasoning: false,
				};
				setSelectedModel(historicalModel);
			}
			if (
				result.thinkingLevel &&
				PI_THINKING_LEVELS.includes(result.thinkingLevel as PiThinkingLevel)
			) {
				setSelectedThinkingLevel(result.thinkingLevel as PiThinkingLevel);
			}
			setThinkingLevels([...getPiModelThinkingLevels(historicalModel)]);
			const stats = result.stats;
			setSessionState({
				name: result.name ?? undefined,
				tokens: stats?.tokens,
				cost: stats?.cost,
				contextTokens: stats?.contextTokens,
			});
		},
		[
			session.projectRecord.id,
			setSelectedModel,
			setSelectedThinkingLevel,
			setThinkingLevels,
		],
	);

	const refreshSessionState = useCallback(async () => {
		const requestId = ++sessionStateRequestRef.current;
		const state = await readCurrentPiSessionState(client);
		if (requestId < sessionStateAppliedRef.current) return;
		sessionStateAppliedRef.current = requestId;
		setSessionState((previous) => mergeRefreshedSessionState(previous, state));
	}, [client]);

	const refreshSessionStats = useCallback(async () => {
		const requestId = ++sessionStateRequestRef.current;
		const stats = await client.getPiSessionStats();
		if (requestId < sessionStateAppliedRef.current) return;
		sessionStateAppliedRef.current = requestId;
		setSessionState((previous) => mergeSessionStats(previous, stats));
	}, [client]);

	return {
		sessionState,
		applyHistoryMetadata,
		refreshSessionState,
		refreshSessionStats,
	};
}
