import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { createChatSessionClient } from "@/lib/api/chat-session-client";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsIncomplete,
	refreshProjectPiModels,
	subscribeProjectPiModels,
} from "@/lib/api/pi-models";
import {
	findMatchingPiModel,
	getNextPiScopeModel,
	getProjectScopeModels,
	isPiScopeCatalogResolved,
	getPiModelThinkingLevels,
	getPiQuickCycleThinkingLevel,
} from "@/lib/pi-model-selection";
import {
	listenRuntimeEvents,
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/api/pi-runtime";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { useChatRuntimeConfiguration } from "@/components/chat/use-chat-runtime-configuration";
import { useChatSessionState } from "@/components/chat/use-chat-session-state";
import { useChatThinkingControls } from "@/components/chat/use-chat-thinking-controls";

import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { useProjectModelScope } from "@/lib/use-project-model-scope";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

type UseChatSessionConfigOptions = {
	session: ChatSession;
	client: ChatSessionClient;
};

export function useChatSessionConfig({
	session,
	client,
}: UseChatSessionConfigOptions) {
	const { t } = useTranslation();
	const scopeConfig = useProjectModelScope(
		tauriPiloClient,
		session.projectRecord.id,
	);
	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void listenRuntimeEvents(scopeConfig.handleEvent)
			.then((stop) => {
				if (disposed) stop();
				else unlisten = stop;
			})
			.catch((error) =>
				console.warn("Failed to subscribe to project model scope", error),
			);
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [scopeConfig.handleEvent]);
	const initialCachedModels = getCachedProjectPiModels(
		session.projectRecord.id,
	);
	const [modelCatalog, setModelCatalog] = useState(initialCachedModels);
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

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Session identity/config changes intentionally reset this controller even when the config values are otherwise equal. */
	useEffect(() => {
		void session.id;
		modelRequestRef.current += 1;
		modelSelectionDirtyRef.current = false;
		thinkingSelectionDirtyRef.current = false;
		const cached = getCachedProjectPiModels(session.projectRecord.id);
		const initialModel =
			session.initialModel ??
			(session.sessionPath ? null : (cached?.defaultModel ?? null));
		setModelCatalog(cached);
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
		let disposed = false;
		const unsubscribe = subscribeProjectPiModels(projectId, (snapshot) => {
			setModelCatalog(snapshot);
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
				if (disposed) return;
				const cached = getCachedProjectPiModels(projectId);
				if (!cached) return;
				setModelCatalog(cached);
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
		return () => {
			disposed = true;
			unsubscribe();
		};
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

	const {
		sessionState,
		sessionHeaderMissing,
		applyHistoryMetadata,
		refreshSessionState,
		refreshSessionStats,
	} = useChatSessionState({
		session,
		client,
		setSelectedModel,
		setSelectedThinkingLevel,
		setThinkingLevels,
	});

	const {
		thinkingLoading,
		thinkingChanging,
		loadThinkingLevels,
		handleThinkingChange,
	} = useChatThinkingControls({
		client,
		sessionPath: session.sessionPath,
		selectedModel,
		selectedThinkingLevel,
		thinkingLevels,
		thinkingSelectionDirtyRef,
		setSelectedThinkingLevel,
		setThinkingLevels,
	});

	const prepareRuntimeConfiguration = useChatRuntimeConfiguration({
		session,
		client,
		selectedModel,
		selectedThinkingLevel,
		modelSelectionDirtyRef,
		thinkingSelectionDirtyRef,
		setSelectedModel,
		setSelectedThinkingLevel,
		setThinkingLevels,
	});

	const loadModelOptions = useCallback(
		async (force = false) => {
			if (modelLoadState === "loading" || modelChanging) return;
			const projectId = session.projectRecord.id;
			const cached =
				getCachedProjectPiModels(projectId) ??
				(modelCatalog?.projectId === projectId ? modelCatalog : null);
			if (session.sessionPath) {
				setModelCatalog(cached);
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
				if (force || !cached || isProjectPiModelsIncomplete(cached)) {
					setModelError(null);
					setModelLoadState("loading");
					const requestId = ++modelRequestRef.current;
					void refreshProjectPiModels(projectId)
						.then((result) => {
							if (modelRequestRef.current !== requestId) return;
							setModelCatalog(result);
							setModelOptions(result.models);
						})
						.catch((error) => {
							if (modelRequestRef.current === requestId)
								setModelError(runtimeErrorMessage(error));
						})
						.finally(() => {
							if (modelRequestRef.current === requestId)
								setModelLoadState("ready");
						});
				}
				return;
			}
			if (!force && cached && !isProjectPiModelsIncomplete(cached)) {
				setModelCatalog(cached);
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
			setModelLoadState("loading");
			setModelError(null);
			try {
				const result = await refreshProjectPiModels(projectId);
				if (modelRequestRef.current !== requestId) return;
				setModelCatalog(result);
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
			modelCatalog,
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
					toast.error(t("chat.modelSwitchFailed"), {
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
			t,
		],
	);

	const catalogCurrent = modelCatalog?.projectId === session.projectRecord.id;
	const availableModels = catalogCurrent ? modelCatalog.models : [];
	const catalogReady =
		catalogCurrent &&
		(scopeConfig.scope?.models != null ||
			isPiScopeCatalogResolved(availableModels));
	const scopeModels = useMemo(
		() =>
			catalogReady && modelCatalog
				? getProjectScopeModels(modelCatalog.models, scopeConfig.scope)
				: [],
		[catalogReady, modelCatalog, scopeConfig.scope],
	);
	const handleQuickCycleModel = useCallback(() => {
		if (modelChanging || !scopeConfig.scope || scopeConfig.error) return;
		if (!catalogReady) {
			void loadModelOptions();
			return;
		}

		const nextModel = getNextPiScopeModel(scopeModels, selectedModel);
		if (!nextModel) return;
		if (session.sessionPath) {
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
				await client.setPiModel(nextModel);
				let supportedLevels = [...getPiModelThinkingLevels(nextModel)];
				try {
					supportedLevels = (await client.getAvailablePiThinkingLevels())
						.levels;
				} catch (error) {
					console.warn(
						"Failed to refresh thinking levels after model cycle",
						error,
					);
				}
				const level = nextModel.scopeThinkingLevel;
				if (level != null) await client.setPiThinkingLevel(level);
				const state = await client.getPiAgentState();
				if (modelRequestRef.current !== requestId) return;
				modelSelectionDirtyRef.current = true;
				thinkingSelectionDirtyRef.current = false;
				setSelectedModel({ ...nextModel, thinkingLevels: supportedLevels });
				setSelectedThinkingLevel(state.thinkingLevel);
				setThinkingLevels(supportedLevels);
				setModelLoadState("ready");
			} catch (error) {
				if (modelRequestRef.current !== requestId) return;
				setSelectedModel(previousModel);
				setSelectedThinkingLevel(previousThinkingLevel);
				toast.error(t("chat.quickModelSwitchFailed"), {
					description: runtimeErrorMessage(error),
				});
			} finally {
				if (modelRequestRef.current === requestId) setModelChanging(false);
			}
		})();
	}, [
		client,
		catalogReady,
		loadModelOptions,
		modelChanging,
		scopeConfig.scope,
		scopeConfig.error,
		scopeModels,
		selectedModel,
		selectedThinkingLevel,
		session.sessionPath,
		t,
	]);

	return {
		modelScope: {
			...scopeConfig,
			models: scopeModels,
			availableModels,
			catalogReady,
		},
		sessionState,
		sessionHeaderMissing,
		commands: catalogCurrent ? modelCatalog.commands : null,
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
		loadModelOptions,
		handleModelChange,
		handleQuickCycleModel,
		loadThinkingLevels,
		handleThinkingChange,
		prepareRuntimeConfiguration,
		refreshSessionState,
		refreshSessionStats,
	};
}
