import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	cacheProjectPiModels,
	getCachedProjectPiModels,
} from "@/lib/pi-models";
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
	const [modelOptions, setModelOptions] = useState<PiModel[]>([]);
	const [selectedModel, setSelectedModel] = useState<PiModel | null>(
		session.initialModel ?? null,
	);
	const [modelLoadState, setModelLoadState] = useState<
		"idle" | "loading" | "ready" | "error"
	>("idle");
	const [modelError, setModelError] = useState<string | null>(null);
	const [modelChanging, setModelChanging] = useState(false);
	const modelRequestRef = useRef(0);
	const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>([]);
	const [selectedThinkingLevel, setSelectedThinkingLevel] =
		useState<PiThinkingLevel>(session.initialThinkingLevel ?? "off");
	const [thinkingLoading, setThinkingLoading] = useState(false);
	const [thinkingChanging, setThinkingChanging] = useState(false);
	const [sessionState, setSessionState] =
		useState<ChatSessionRuntimeState | null>(null);
	const initialConfigAppliedRef = useRef(new Set<string>());

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Session identity/config changes intentionally reset this controller even when the config values are otherwise equal. */
	useEffect(() => {
		void session.id;
		modelRequestRef.current += 1;
		setSessionState(null);
		setModelOptions(
			getCachedProjectPiModels(session.projectRecord.id)?.models ?? [],
		);
		setSelectedModel(session.initialModel ?? null);
		setModelLoadState("idle");
		setModelError(null);
		setModelChanging(false);
		setThinkingLevels([]);
		setSelectedThinkingLevel(session.initialThinkingLevel ?? "off");
	}, [
		session.id,
		session.initialModel,
		session.initialThinkingLevel,
		session.projectRecord.id,
	]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	const applyHistoryMetadata = useCallback(
		(result: SessionHistory) => {
			const cachedModels =
				getCachedProjectPiModels(session.projectRecord.id)?.models ?? [];
			if (result.model) {
				const historicalModel = cachedModels.find(
					(model) =>
						model.provider === result.model?.provider &&
						model.id === result.model?.id,
				) ?? {
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
			setThinkingLevels(PI_THINKING_LEVELS);
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

	const loadModelOptions = useCallback(async () => {
		if (modelLoadState === "loading" || modelChanging) return;
		const requestId = ++modelRequestRef.current;
		setModelLoadState("loading");
		setModelError(null);
		if (session.sessionPath) {
			const cached =
				getCachedProjectPiModels(session.projectRecord.id)?.models ?? [];
			const options =
				selectedModel &&
				!cached.some(
					(model) =>
						model.provider === selectedModel.provider &&
						model.id === selectedModel.id,
				)
					? [selectedModel, ...cached]
					: cached;
			setModelOptions(options);
			setThinkingLevels(PI_THINKING_LEVELS);
			setModelLoadState("ready");
			return;
		}
		try {
			await client.ensure();
			const [state, result, thinking] = await Promise.all([
				client.getPiAgentState(),
				client.getAvailablePiModels(),
				client.getAvailablePiThinkingLevels(),
			]);
			if (modelRequestRef.current !== requestId) return;
			setSelectedModel(state.model);
			setModelOptions(result.models);
			cacheProjectPiModels(session.projectRecord.id, result.models);
			setSelectedThinkingLevel(state.thinkingLevel);
			setThinkingLevels(thinking.levels);
			setModelLoadState("ready");
		} catch (error) {
			if (modelRequestRef.current !== requestId) return;
			setModelError(runtimeErrorMessage(error));
			setModelLoadState("error");
		}
	}, [
		client,
		modelChanging,
		modelLoadState,
		selectedModel,
		session.projectRecord.id,
		session.sessionPath,
	]);

	const handleModelChange = useCallback(
		(model: PiModel | null) => {
			if (!model || modelChanging) return;
			if (session.sessionPath) {
				setSelectedModel(model);
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
		[client, modelChanging, selectedModel, session.sessionPath],
	);

	const loadThinkingLevels = useCallback(async () => {
		if (thinkingLoading || thinkingChanging) return;
		if (session.sessionPath) {
			setThinkingLevels(PI_THINKING_LEVELS);
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
	}, [client, session.sessionPath, thinkingChanging, thinkingLoading]);

	const handleThinkingChange = useCallback(
		(level: PiThinkingLevel | null) => {
			if (!level || thinkingChanging || level === selectedThinkingLevel) return;
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
		[client, selectedThinkingLevel, session.sessionPath, thinkingChanging],
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
		loadThinkingLevels,
		handleThinkingChange,
		prepareRuntimeConfiguration,
		refreshSessionState,
	};
}
