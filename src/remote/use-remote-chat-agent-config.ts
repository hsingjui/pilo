import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import type {
	PiAgentState,
	PiModel,
	PiSessionStats,
	PiThinkingLevel,
} from "@/lib/api/pi-runtime";
import type { ProjectPiModels } from "@/lib/api/pi-models";
import {
	findMatchingPiModel,
	getPiModelThinkingLevels,
} from "@/lib/pi-model-selection";
import { PI_THINKING_LEVELS, runtimeErrorMessage } from "@/lib/api/pi-runtime";
import type { SessionHistory, SessionIndexEntry } from "@/lib/api/sessions";
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
	const [historyMetadata, setHistoryMetadata] = useState<Pick<
		SessionHistory,
		"model" | "thinkingLevel" | "name" | "stats" | "headerMissing"
	> | null>(null);
	const [models, setModels] = useState<PiModel[]>([]);
	const [modelsLoaded, setModelsLoaded] = useState(false);
	// 仅用于 composer 的模型刷新按钮；与 Desktop 的 modelLoadState 对齐，
	// 不再是「下拉菜单首行」文案。
	const [modelLoading, setModelLoading] = useState(false);
	const [modelError, setModelError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<ProjectPiModels | null>(null);
	const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>([]);
	// 仅保存用户明确选择的启动配置；目录默认值只用于草稿展示。
	const [draftModel, setDraftModel] = useState<PiModel | null>(null);
	const [draftThinkingLevel, setDraftThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const draftCatalogRequestRef = useRef(0);
	const configKey = selectedSession?.sessionPath ?? draftId;
	const configIdentityRef = useRef({ projectId: activeProjectId, configKey });

	const applyHistoryMetadata = useCallback((history: SessionHistory) => {
		setAgentState(null);
		setChatState(null);
		// Keep only metadata, not the replay events or image payloads.
		setHistoryMetadata({
			model: history.model,
			thinkingLevel: history.thinkingLevel,
			name: history.name,
			stats: history.stats,
			headerMissing: history.headerMissing,
		});
	}, []);
	const historyModel = useMemo<PiModel | null>(() => {
		const model = historyMetadata?.model;
		if (!model) return null;
		return (
			findMatchingPiModel(models, model) ?? {
				...model,
				name: model.id,
				reasoning: false,
			}
		);
	}, [historyMetadata, models]);
	const historyThinkingLevel =
		PI_THINKING_LEVELS.find(
			(level) => level === historyMetadata?.thinkingLevel,
		) ?? null;

	const refreshAgentConfig = useCallback(
		async (liveRuntime = true) => {
			if (
				configIdentityRef.current.projectId !== activeProjectId ||
				configIdentityRef.current.configKey !== configKey
			)
				return;
			const requestId = ++draftCatalogRequestRef.current;
			setModelLoading(true);
			setModelError(null);
			try {
				const [liveResult, hostResult] = await Promise.allSettled([
					liveRuntime
						? Promise.all([
								rpc<PiAgentState>({ type: "get_state" }),
								rpc<{ levels: PiThinkingLevel[] }>({
									type: "get_available_thinking_levels",
								}),
								rpc<PiSessionStats>({ type: "get_session_stats" }),
							])
						: Promise.resolve(null),
					client?.loadModels(activeProjectId) ?? Promise.resolve(null),
				]);
				if (draftCatalogRequestRef.current !== requestId) return;
				const hostCatalog =
					hostResult.status === "fulfilled" ? hostResult.value : null;
				if (hostResult.status === "fulfilled") {
					setCatalog(hostCatalog);
					setModelsLoaded(hostCatalog !== null);
					setModels(hostCatalog?.models ?? []);
				}
				if (liveResult.status === "rejected") throw liveResult.reason;
				if (hostResult.status === "rejected")
					setModelError(runtimeErrorMessage(hostResult.reason));
				if (!liveResult.value) return;
				const [state, thinkingResult, stats] = liveResult.value;
				setAgentState(state);
				setThinkingLevels(thinkingResult.levels);
				setChatState({
					name: state.sessionName,
					tokens: stats.tokens,
					cost: stats.cost,
					contextTokens: stats.contextUsage?.tokens,
					contextWindow: stats.contextUsage?.contextWindow,
					contextPercent: stats.contextUsage?.percent,
				});
			} catch (error) {
				if (draftCatalogRequestRef.current === requestId)
					setModelError(runtimeErrorMessage(error));
			} finally {
				if (draftCatalogRequestRef.current === requestId)
					setModelLoading(false);
			}
		},
		[activeProjectId, client, configKey, rpc],
	);

	const loadDraftCatalog = useCallback(
		(projectId: string, force = false) => {
			if (configIdentityRef.current.projectId !== projectId)
				return Promise.resolve();
			const requestId = ++draftCatalogRequestRef.current;
			setModelLoading(true);
			setModelError(null);
			return (client?.loadModels(projectId, force) ?? Promise.resolve(null))
				.then((loaded) => {
					if (draftCatalogRequestRef.current !== requestId) return;
					setCatalog(loaded);
					setModelsLoaded(loaded !== null);
					setModels(loaded?.models ?? []);
				})
				.catch((error) => {
					if (draftCatalogRequestRef.current !== requestId) return;
					setModelError(runtimeErrorMessage(error));
				})
				.finally(() => {
					if (draftCatalogRequestRef.current === requestId)
						setModelLoading(false);
				});
		},
		[client],
	);

	/* oxlint-disable react/set-state-in-effect -- Reset catalog identity before resolving another project/session. */
	useEffect(() => {
		configIdentityRef.current = { projectId: activeProjectId, configKey };
		setAgentState(null);
		setChatState(null);
		setHistoryMetadata(null);
		setThinkingLevels([]);
		setCatalog(null);
		setModels([]);
		setModelsLoaded(false);
		setModelLoading(false);
		setModelError(null);
		draftCatalogRequestRef.current += 1;
		return () => {
			draftCatalogRequestRef.current += 1;
		};
	}, [activeProjectId, configKey]);
	/* oxlint-enable react/set-state-in-effect */

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
		chatState:
			chatState ??
			(historyMetadata
				? {
						name: historyMetadata.name ?? undefined,
						tokens: historyMetadata.stats?.tokens,
						cost: historyMetadata.stats?.cost,
						contextTokens: historyMetadata.stats?.contextTokens,
					}
				: null),
		setChatState,
		sessionHeaderMissing: historyMetadata?.headerMissing ?? false,
		historyModel,
		historyThinkingLevel,
		applyHistoryMetadata,
		models,
		setModels,
		modelLoading,
		modelsLoaded,
		modelError,
		catalog,
		thinkingLevels: agentState
			? thinkingLevels
			: [...getPiModelThinkingLevels(historyModel)],
		setThinkingLevels,
		draftModel,
		setDraftModel,
		draftThinkingLevel,
		setDraftThinkingLevel,
		refreshAgentConfig,
		loadDraftCatalog,
	};
}
