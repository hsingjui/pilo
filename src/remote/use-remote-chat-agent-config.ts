import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import type {
	PiAgentState,
	PiModel,
	PiSessionStats,
	PiThinkingLevel,
} from "@/lib/pi-runtime";
import type { SessionIndexEntry } from "@/lib/sessions";
import type { RemoteRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatAgentConfigOptions = {
	client: WebPiloClient | null;
	rpc: RemoteRpc;
	activeProjectId: string;
	draftId: string;
	selectedSession: SessionIndexEntry | null;
};

export function useRemoteChatAgentConfig({
	client,
	rpc,
	activeProjectId,
	draftId,
	selectedSession,
}: UseRemoteChatAgentConfigOptions) {
	const [agentState, setAgentState] = useState<PiAgentState | null>(null);
	const [chatState, setChatState] = useState<ChatSessionRuntimeState | null>(
		null,
	);
	const [models, setModels] = useState<PiModel[]>([]);
	// 仅用于 composer 的模型刷新按钮；与 Desktop 的 modelLoadState 对齐，
	// 不再是「下拉菜单首行」文案。
	const [modelLoading, setModelLoading] = useState(false);
	const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>([]);
	const [draftModel, setDraftModel] = useState<PiModel | null>(null);
	const [draftThinkingLevel, setDraftThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const draftCatalogRequestRef = useRef(0);

	const refreshAgentConfig = useCallback(async () => {
		setModelLoading(true);
		try {
			const [state, modelResult, thinkingResult, stats] = await Promise.all([
				rpc<PiAgentState>({ type: "get_state" }),
				rpc<{ models: PiModel[] }>({ type: "get_available_models" }),
				rpc<{ levels: PiThinkingLevel[] }>({
					type: "get_available_thinking_levels",
				}),
				rpc<PiSessionStats>({ type: "get_session_stats" }),
			]);
			setAgentState(state);
			setModels(modelResult.models);
			setThinkingLevels(thinkingResult.levels);
			setChatState({
				name: state.sessionName,
				tokens: stats.tokens,
				cost: stats.cost,
				contextTokens: stats.contextUsage?.tokens,
				contextWindow: stats.contextUsage?.contextWindow,
				contextPercent: stats.contextUsage?.percent,
			});
		} catch {
			// Optional model metadata can fail while the chat stream remains usable.
		} finally {
			setModelLoading(false);
		}
	}, [rpc]);

	const loadDraftCatalog = useCallback(
		(projectId: string) => {
			const requestId = ++draftCatalogRequestRef.current;
			setModelLoading(true);
			return (client?.loadModels(projectId) ?? Promise.resolve(null))
				.then((catalog) => {
					if (draftCatalogRequestRef.current !== requestId || !catalog) return;
					setModels(catalog.models);
					setDraftModel((current) => current ?? catalog.defaultModel);
					setDraftThinkingLevel(
						(current) => current ?? catalog.defaultThinkingLevel,
					);
				})
				.catch((error) => {
					if (draftCatalogRequestRef.current !== requestId) return;
					console.warn("Failed to load remote model catalog", error);
				})
				.finally(() => {
					if (draftCatalogRequestRef.current === requestId)
						setModelLoading(false);
				});
		},
		[client],
	);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- The draft landing page preloads the Host-cached Pi model catalog, and draftId intentionally retriggers it for every new draft. */
	useEffect(() => {
		void draftId;
		if (selectedSession || !activeProjectId) return;
		void loadDraftCatalog(activeProjectId);
		return () => {
			draftCatalogRequestRef.current += 1;
		};
	}, [activeProjectId, draftId, loadDraftCatalog, selectedSession]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	return {
		agentState,
		setAgentState,
		chatState,
		setChatState,
		models,
		setModels,
		modelLoading,
		thinkingLevels,
		setThinkingLevels,
		draftModel,
		setDraftModel,
		draftThinkingLevel,
		setDraftThinkingLevel,
		refreshAgentConfig,
		loadDraftCatalog,
	};
}
