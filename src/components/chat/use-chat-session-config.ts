import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsStale,
	refreshProjectPiModels,
	subscribeProjectPiModels,
} from "@/lib/pi-models";
import {
	findMatchingPiModel,
	getNextPiQuickCycleModel,
	getPiModelThinkingLevels,
	getPiQuickCycleThinkingLevel,
} from "@/lib/pi-model-selection";
import {
	PI_THINKING_LEVELS,
	runtimeErrorMessage,
	type PiAgentState,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";
import type { SessionHistory } from "@/lib/sessions";
import {
	readCurrentPiSessionState,
	type ChatSession,
	type ChatSessionRuntimeState,
} from "@/components/chat/chat-page-utils";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

type UseChatSessionConfigOptions = {
	session: ChatSession;
	client: ChatSessionClient;
	onSessionChanged?: () => void;
};

export function useChatSessionConfig({
	session,
	client,
	onSessionChanged,
}: UseChatSessionConfigOptions) {
	const initialCachedModels = getCachedProjectPiModels(
		session.projectRecord.id,
	);
	const [modelOptions, setModelOptions] = useState<PiModel[]>(
		initialCachedModels?.models ?? [],
	);
	const [selectedModel, setSelectedModel] = useState<PiModel | null>(
		session.initialModel ??
			(session.sessionPath
				? null
				: (initialCachedModels?.defaultModel ?? null)),
	);
	const [modelLoadState, setModelLoadState] = useState<
		"idle" | "loading" | "ready" | "error"
	>("idle");
	const [modelError, setModelError] = useState<string | null>(null);
	const [modelChanging, setModelChanging] = useState(false);
	const modelRequestRef = useRef(0);
	const modelSelectionDirtyRef = useRef(false);
	const thinkingSelectionDirtyRef = useRef(false);
	const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>(
		(session.initialModel ?? initialCachedModels?.defaultModel)
			?.thinkingLevels ?? [],
	);
	const [selectedThinkingLevel, setSelectedThinkingLevel] =
		useState<PiThinkingLevel>(
			session.initialThinkingLevel ??
				(session.sessionPath
					? "off"
					: (initialCachedModels?.defaultThinkingLevel ?? "off")),
		);
	const [thinkingLoading, setThinkingLoading] = useState(false);
	const [thinkingChanging, setThinkingChanging] = useState(false);
	const [sessionState, setSessionState] =
		useState<ChatSessionRuntimeState | null>(null);
	const initialConfigAppliedRef = useRef(new Set<string>());

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Session identity/config changes intentionally reset this controller even when the config values are otherwise equal. */
	useEffect(() => {
		void session.id;
		modelRequestRef.current += 1;
		modelSelectionDirtyRef.current = false;
		thinkingSelectionDirtyRef.current = false;
		setSessionState(null);
		const cached = getCachedProjectPiModels(session.projectRecord.id);
		const initialModel =
			session.initialModel ??
			(session.sessionPath ? null : (cached?.defaultModel ?? null));
		setModelOptions(cached?.models ?? []);
		setSelectedModel(initialModel);
		setModelLoadState("idle");
		setModelError(null);
		setModelChanging(false);
		setThinkingLevels(initialModel?.thinkingLevels ?? []);
		setSelectedThinkingLevel(
			session.initialThinkingLevel ??
				(session.sessionPath ? "off" : (cached?.defaultThinkingLevel ?? "off")),
		);
	}, [
		session.id,
		session.initialModel,
		session.initialThinkingLevel,
		session.projectRecord.id,
		session.sessionPath,
	]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	useEffect(() => {
		const projectId = session.projectRecord.id;
		const unsubscribe = subscribeProjectPiModels(projectId, (snapshot) => {
			setModelOptions(snapshot.models);
			if (
				!session.sessionPath &&
				!session.initialModel &&
				!modelSelectionDirtyRef.current
			) {
				setSelectedModel(snapshot.defaultModel);
				setThinkingLevels(snapshot.defaultModel?.thinkingLevels ?? []);
			}
			if (
				!session.sessionPath &&
				!session.initialThinkingLevel &&
				!thinkingSelectionDirtyRef.current &&
				snapshot.defaultThinkingLevel
			) {
				setSelectedThinkingLevel(snapshot.defaultThinkingLevel);
			}
			setModelLoadState("ready");
			setModelError(null);
		});
		void hydrateProjectPiModels()
			.then(() => {
				const cached = getCachedProjectPiModels(projectId);
				if (!cached) return;
				setModelOptions(cached.models);
				if (
					!session.sessionPath &&
					!session.initialModel &&
					!modelSelectionDirtyRef.current
				) {
					setSelectedModel(cached.defaultModel);
					setThinkingLevels(cached.defaultModel?.thinkingLevels ?? []);
				}
				if (
					!session.sessionPath &&
					!session.initialThinkingLevel &&
					!thinkingSelectionDirtyRef.current &&
					cached.defaultThinkingLevel
				) {
					setSelectedThinkingLevel(cached.defaultThinkingLevel);
				}
				setModelLoadState("ready");
			})
			.catch((error) => console.warn("Failed to hydrate Pi models", error));
		return unsubscribe;
	}, [
		session.initialModel,
		session.initialThinkingLevel,
		session.projectRecord.id,
		session.sessionPath,
	]);

	/* oxlint-disable react/set-state-in-effect -- Cached model profiles can arrive after history metadata; enrich the selected historical model without starting Pi. */
	useEffect(() => {
		if (!session.sessionPath || !selectedModel) return;
		const profiledModel = findMatchingPiModel(modelOptions, selectedModel);
		if (!profiledModel) return;
		if (profiledModel !== selectedModel) setSelectedModel(profiledModel);
		setThinkingLevels([...getPiModelThinkingLevels(profiledModel)]);
	}, [modelOptions, selectedModel, session.sessionPath]);
	/* oxlint-enable react/set-state-in-effect */

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
			setSessionState({
				name: result.name ?? undefined,
				messageCount: result.sourceMessageCount,
			});
		},
		[session.projectRecord.id],
	);

	const handleRenameSession = useCallback(async () => {
		if (session.sessionPath) {
			toast.info(
				"历史 Session 在查看时保持只读。继续对话后再由 Pi 管理 Session 元数据。",
			);
			return;
		}
		const name = window
			.prompt("Session name", sessionState?.name || session.title)
			?.trim();
		if (!name) return;
		try {
			await client.ensure();
			await client.setPiSessionName(name);
			setSessionState((current) => ({ ...current, name }));
			onSessionChanged?.();
		} catch (error) {
			toast.error("无法重命名 Session", {
				description: runtimeErrorMessage(error),
			});
		}
	}, [
		client,
		onSessionChanged,
		session.sessionPath,
		session.title,
		sessionState?.name,
	]);

	const loadModelOptions = useCallback(
		async (force = false) => {
			if (modelLoadState === "loading" || modelChanging) return;
			const projectId = session.projectRecord.id;
			const cached = getCachedProjectPiModels(projectId);
			if (session.sessionPath) {
				const profiledSelectedModel =
					findMatchingPiModel(cached?.models ?? [], selectedModel) ??
					selectedModel;
				const options =
					profiledSelectedModel &&
					!cached?.models.some(
						(model) =>
							model.provider === profiledSelectedModel.provider &&
							model.id === profiledSelectedModel.id,
					)
						? [profiledSelectedModel, ...(cached?.models ?? [])]
						: (cached?.models ?? []);
				setModelOptions(options);
				if (profiledSelectedModel) setSelectedModel(profiledSelectedModel);
				setThinkingLevels([...getPiModelThinkingLevels(profiledSelectedModel)]);
				setModelLoadState("ready");
				if (force || !cached || isProjectPiModelsStale(cached)) {
					setModelError(null);
					if (force || !cached) setModelLoadState("loading");
					void refreshProjectPiModels(projectId)
						.catch((error) => {
							setModelError(runtimeErrorMessage(error));
						})
						.finally(() => setModelLoadState("ready"));
				}
				return;
			}
			if (!force && cached && !isProjectPiModelsStale(cached)) {
				setModelOptions(cached.models);
				if (!session.initialModel && !modelSelectionDirtyRef.current) {
					setSelectedModel(cached.defaultModel);
					setThinkingLevels(cached.defaultModel?.thinkingLevels ?? []);
				}
				if (
					!session.initialThinkingLevel &&
					!thinkingSelectionDirtyRef.current &&
					cached.defaultThinkingLevel
				) {
					setSelectedThinkingLevel(cached.defaultThinkingLevel);
				}
				setModelLoadState("ready");
				setModelError(null);
				return;
			}
			const requestId = ++modelRequestRef.current;
			if (force || !cached) setModelLoadState("loading");
			setModelError(null);
			try {
				const result = await refreshProjectPiModels(projectId);
				if (modelRequestRef.current !== requestId) return;
				setModelOptions(result.models);
				if (!session.initialModel && !modelSelectionDirtyRef.current) {
					setSelectedModel(result.defaultModel);
					setThinkingLevels(result.defaultModel?.thinkingLevels ?? []);
				}
				if (
					!session.initialThinkingLevel &&
					!thinkingSelectionDirtyRef.current &&
					result.defaultThinkingLevel
				) {
					setSelectedThinkingLevel(result.defaultThinkingLevel);
				}
				setModelLoadState("ready");
			} catch (error) {
				if (modelRequestRef.current !== requestId) return;
				setModelError(runtimeErrorMessage(error));
				setModelLoadState(cached ? "ready" : "error");
			}
		},
		[
			modelChanging,
			modelLoadState,
			selectedModel,
			session.initialModel,
			session.initialThinkingLevel,
			session.projectRecord.id,
			session.sessionPath,
		],
	);

	const handleModelChange = useCallback(
		(model: PiModel | null) => {
			if (!model || modelChanging) return;
			modelSelectionDirtyRef.current = true;
			thinkingSelectionDirtyRef.current = false;
			if (session.sessionPath) {
				setSelectedModel(model);
				setThinkingLevels([...getPiModelThinkingLevels(model)]);
				setSelectedThinkingLevel(
					model.defaultThinkingLevel ?? selectedThinkingLevel,
				);
				setModelError(null);
				return;
			}
			const previousModel = selectedModel;
			const requestId = ++modelRequestRef.current;
			setSelectedModel(model);
			setModelChanging(true);
			setModelError(null);

			void (async () => {
				try {
					await client.ensure();
					const applied = await client.setPiModel(model);
					const [state, thinking] = await Promise.all([
						client.getPiAgentState(),
						client.getAvailablePiThinkingLevels(),
					]);
					if (modelRequestRef.current !== requestId) return;
					setSelectedModel(state.model ?? applied);
					setSelectedThinkingLevel(state.thinkingLevel);
					setThinkingLevels(thinking.levels);
					setModelLoadState("ready");
				} catch (error) {
					if (modelRequestRef.current !== requestId) return;
					setSelectedModel(previousModel);
					toast.error("无法切换模型", {
						description: runtimeErrorMessage(error),
					});
				} finally {
					if (modelRequestRef.current === requestId) setModelChanging(false);
				}
			})();
		},
		[
			client,
			modelChanging,
			selectedModel,
			selectedThinkingLevel,
			session.sessionPath,
		],
	);

	const handleQuickCycleModel = useCallback(() => {
		if (modelChanging) return;

		if (session.sessionPath) {
			if (modelOptions.length === 0) {
				void loadModelOptions();
				return;
			}
			const nextModel = getNextPiQuickCycleModel(modelOptions, selectedModel);
			if (!nextModel) return;
			modelSelectionDirtyRef.current = true;
			thinkingSelectionDirtyRef.current = false;
			setSelectedModel(nextModel);
			setThinkingLevels([...getPiModelThinkingLevels(nextModel)]);
			const nextThinkingLevel = getPiQuickCycleThinkingLevel(nextModel);
			if (nextThinkingLevel) setSelectedThinkingLevel(nextThinkingLevel);
			setModelError(null);
			return;
		}

		const previousModel = selectedModel;
		const previousThinkingLevel = selectedThinkingLevel;
		const requestId = ++modelRequestRef.current;
		setModelChanging(true);
		setModelError(null);
		void (async () => {
			try {
				await client.ensure();
				const result = await client.cyclePiModel();
				if (!result) return;
				const cachedModels =
					getCachedProjectPiModels(session.projectRecord.id)?.models ?? [];
				const profiledModel =
					findMatchingPiModel(cachedModels, result.model) ?? result.model;
				let supportedLevels = [...getPiModelThinkingLevels(profiledModel)];
				try {
					supportedLevels = (await client.getAvailablePiThinkingLevels())
						.levels;
				} catch (error) {
					console.warn(
						"Failed to refresh thinking levels after model cycle",
						error,
					);
				}
				if (modelRequestRef.current !== requestId) return;
				modelSelectionDirtyRef.current = true;
				thinkingSelectionDirtyRef.current = false;
				setSelectedModel({ ...profiledModel, thinkingLevels: supportedLevels });
				setSelectedThinkingLevel(result.thinkingLevel);
				setThinkingLevels(supportedLevels);
				setModelLoadState("ready");
			} catch (error) {
				if (modelRequestRef.current !== requestId) return;
				setSelectedModel(previousModel);
				setSelectedThinkingLevel(previousThinkingLevel);
				toast.error("无法快速切换模型", {
					description: runtimeErrorMessage(error),
				});
			} finally {
				if (modelRequestRef.current === requestId) setModelChanging(false);
			}
		})();
	}, [
		client,
		loadModelOptions,
		modelChanging,
		modelOptions,
		selectedModel,
		selectedThinkingLevel,
		session.projectRecord.id,
		session.sessionPath,
	]);

	const loadThinkingLevels = useCallback(async () => {
		if (thinkingLoading || thinkingChanging) return;
		if (session.sessionPath) {
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
			toast.error("无法读取思考等级", {
				description: runtimeErrorMessage(error),
			});
		} finally {
			setThinkingLoading(false);
		}
	}, [
		client,
		selectedModel,
		session.sessionPath,
		thinkingChanging,
		thinkingLoading,
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
			if (session.sessionPath) {
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
					toast.error("无法切换思考等级", {
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
			session.sessionPath,
			thinkingChanging,
			thinkingLevels,
		],
	);

	const prepareRuntimeConfiguration = useCallback(
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
			if (session.initialModel) {
				await client.setPiModel(session.initialModel);
			}
			if (session.initialThinkingLevel) {
				await client.setPiThinkingLevel(session.initialThinkingLevel);
			}
			if (session.initialModel || session.initialThinkingLevel) {
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
		],
	);

	const refreshSessionState = useCallback(async () => {
		const state = await readCurrentPiSessionState(client);
		setSessionState(state);
	}, [client]);

	return {
		sessionState,
		modelOptions,
		selectedModel,
		modelLoadState,
		modelError,
		modelChanging,
		thinkingLevels,
		selectedThinkingLevel,
		thinkingLoading,
		thinkingChanging,
		applyHistoryMetadata,
		handleRenameSession,
		loadModelOptions,
		handleModelChange,
		handleQuickCycleModel,
		loadThinkingLevels,
		handleThinkingChange,
		prepareRuntimeConfiguration,
		refreshSessionState,
	};
}
