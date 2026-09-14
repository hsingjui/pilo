import { useCallback, useEffect, useRef, useState } from "react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { SessionHeader } from "@/components/chat/chat-session-header";
import {
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";
import {
	getNextPiQuickCycleModel,
	getPiModelThinkingLevels,
	getPiQuickCycleThinkingLevel,
} from "@/lib/pi-model-selection";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsStale,
	refreshProjectPiModels,
	subscribeProjectPiModels,
} from "@/lib/pi-models";
import { usePreferences } from "@/lib/preferences-provider";
import type { Project } from "@/lib/projects";
import type { ChatSubmission } from "@/lib/chat-submission";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";

function modelKey(model: PiModel | null): string | null {
	return model ? `${model.provider}\0${model.id}` : null;
}

export function NewChatLanding({
	onStartSession,
	onOpenTerminal,
	terminalRunning = false,
	terminalVisible = false,
	onNewTemporaryChat,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
	projectAvailable = true,
	project = null,
}: {
	onStartSession: (
		submission: ChatSubmission,
		model: PiModel | null,
		thinkingLevel: PiThinkingLevel | null,
	) => void;
	onOpenTerminal?: () => void;
	terminalRunning?: boolean;
	terminalVisible?: boolean;
	onNewTemporaryChat?: () => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
	projectAvailable?: boolean;
	project?: Project | null;
}) {
	const { keyboardShortcuts } = usePreferences();
	const projectId = project?.id ?? null;
	const cachedModels = projectId ? getCachedProjectPiModels(projectId) : null;
	const [draft, setDraft] = useState("");
	const [models, setModels] = useState<PiModel[]>(cachedModels?.models ?? []);
	const [selectedModel, setSelectedModel] = useState<PiModel | null>(
		cachedModels?.defaultModel ?? null,
	);
	const [selectedThinkingLevel, setSelectedThinkingLevel] =
		useState<PiThinkingLevel | null>(
			cachedModels?.defaultThinkingLevel ?? null,
		);
	const [modelLoadState, setModelLoadState] = useState<
		"idle" | "loading" | "ready" | "error"
	>(cachedModels ? "ready" : "idle");
	const [modelError, setModelError] = useState<string | null>(null);
	const modelRequestRef = useRef(0);
	const modelLoadingRef = useRef(false);
	const modelSelectionDirtyRef = useRef(false);
	const thinkingSelectionDirtyRef = useRef(false);
	const selectedModelKeyRef = useRef(
		modelKey(cachedModels?.defaultModel ?? null),
	);

	const applyModelSnapshot = useCallback(
		(snapshot: NonNullable<ReturnType<typeof getCachedProjectPiModels>>) => {
			setModels(snapshot.models);
			if (!modelSelectionDirtyRef.current) {
				selectedModelKeyRef.current = modelKey(snapshot.defaultModel);
				setSelectedModel(snapshot.defaultModel);
				if (!thinkingSelectionDirtyRef.current) {
					setSelectedThinkingLevel(snapshot.defaultThinkingLevel);
				}
			} else {
				const selectedKey = selectedModelKeyRef.current;
				const refreshedSelectedModel = selectedKey
					? snapshot.models.find((model) => modelKey(model) === selectedKey)
					: null;
				if (refreshedSelectedModel) {
					setSelectedModel(refreshedSelectedModel);
					if (!thinkingSelectionDirtyRef.current) {
						setSelectedThinkingLevel(
							refreshedSelectedModel.defaultThinkingLevel ?? null,
						);
					}
				}
			}
			setModelLoadState("ready");
			setModelError(null);
		},
		[
			setModelError,
			setModelLoadState,
			setModels,
			setSelectedModel,
			setSelectedThinkingLevel,
		],
	);

	const loadModels = useCallback(
		async (force = false) => {
			if (!projectId || modelLoadingRef.current) return;
			const cached = getCachedProjectPiModels(projectId);
			if (!force && cached && !isProjectPiModelsStale(cached)) {
				applyModelSnapshot(cached);
				return;
			}
			const requestId = ++modelRequestRef.current;
			modelLoadingRef.current = true;
			if (force || !cached) setModelLoadState("loading");
			setModelError(null);
			try {
				const result = await refreshProjectPiModels(projectId);
				if (modelRequestRef.current !== requestId) return;
				applyModelSnapshot(result);
			} catch (error) {
				if (modelRequestRef.current !== requestId) return;
				setModelError(runtimeErrorMessage(error));
				setModelLoadState(cached ? "ready" : "error");
			} finally {
				if (modelRequestRef.current === requestId) {
					modelLoadingRef.current = false;
				}
			}
		},
		[applyModelSnapshot, projectId, setModelError, setModelLoadState],
	);

	/* oxlint-disable react/set-state-in-effect -- Changing project identity intentionally resets the draft run configuration to that project's cached Pi defaults. */
	useEffect(() => {
		modelSelectionDirtyRef.current = false;
		thinkingSelectionDirtyRef.current = false;
		const cached = projectId ? getCachedProjectPiModels(projectId) : null;
		setModels(cached?.models ?? []);
		selectedModelKeyRef.current = modelKey(cached?.defaultModel ?? null);
		setSelectedModel(cached?.defaultModel ?? null);
		setSelectedThinkingLevel(cached?.defaultThinkingLevel ?? null);
		setModelLoadState(cached ? "ready" : "idle");
		setModelError(null);
	}, [projectId]);
	/* oxlint-enable react/set-state-in-effect */

	useEffect(() => {
		if (!projectId) return;
		const unsubscribe = subscribeProjectPiModels(projectId, applyModelSnapshot);
		void hydrateProjectPiModels()
			.then(() => {
				const cached = getCachedProjectPiModels(projectId);
				if (cached) applyModelSnapshot(cached);
				if (!cached) void loadModels();
			})
			.catch((error) => {
				console.warn("Failed to hydrate Pi models", error);
				void loadModels();
			});
		return () => {
			unsubscribe();
			modelRequestRef.current += 1;
			modelLoadingRef.current = false;
		};
	}, [applyModelSnapshot, loadModels, projectId]);

	const selectDraftModel = (
		model: PiModel,
		thinkingLevel = model.defaultThinkingLevel ?? null,
	) => {
		modelSelectionDirtyRef.current = true;
		thinkingSelectionDirtyRef.current = false;
		selectedModelKeyRef.current = modelKey(model);
		setSelectedModel(model);
		setSelectedThinkingLevel(thinkingLevel);
	};

	useKeyboardShortcut(
		keyboardShortcuts["cycle-model"],
		() => {
			if (models.length === 0) {
				void loadModels();
				return;
			}
			const currentKey = modelKey(selectedModel);
			const currentIndex = currentKey
				? models.findIndex((model) => modelKey(model) === currentKey)
				: -1;
			const nextModel = models[(currentIndex + 1) % models.length];
			if (!nextModel) return;
			selectDraftModel(nextModel);
		},
		{
			enabled:
				Boolean(project) && projectAvailable && modelLoadState !== "loading",
		},
	);

	useKeyboardShortcut(
		keyboardShortcuts["cycle-scoped-model"],
		() => {
			if (models.length === 0) {
				void loadModels();
				return;
			}
			const nextModel = getNextPiQuickCycleModel(models, selectedModel);
			if (!nextModel) return;
			selectDraftModel(nextModel, getPiQuickCycleThinkingLevel(nextModel));
		},
		{
			enabled:
				Boolean(project) && projectAvailable && modelLoadState !== "loading",
		},
	);

	return (
		<div className="relative flex h-full min-w-0 flex-col">
			<SessionHeader
				overlay
				onOpenTerminal={onOpenTerminal}
				terminalRunning={terminalRunning}
				terminalVisible={terminalVisible}
				onNewTemporaryChat={onNewTemporaryChat}
				onExpandSidebar={onExpandSidebar}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div className="flex min-h-0 w-full flex-1 flex-col">
					<ConversationColumn className="flex flex-1 items-center justify-center">
						<ChatEmptyHero />
					</ConversationColumn>
				</div>
				<div className="relative -mt-4 w-full shrink-0 pb-4">
					<ConversationColumn className="relative">
						<ChatComposer
							value={draft}
							onChange={setDraft}
							onSubmit={(submission) =>
								onStartSession(submission, selectedModel, selectedThinkingLevel)
							}
							disabled={false}
							models={models}
							selectedModel={selectedModel}
							modelLoading={modelLoadState === "loading"}
							modelError={modelError}
							modelDisabled={!projectAvailable || !project}
							onModelMenuOpen={() => void loadModels()}
							onModelRefresh={() => void loadModels(true)}
							onModelChange={(model) => {
								if (model) selectDraftModel(model);
							}}
							thinkingLevels={getPiModelThinkingLevels(selectedModel)}
							selectedThinkingLevel={selectedThinkingLevel}
							thinkingDisabled={
								!projectAvailable ||
								!project ||
								getPiModelThinkingLevels(selectedModel).length === 0
							}
							onThinkingChange={(level) => {
								thinkingSelectionDirtyRef.current = true;
								setSelectedThinkingLevel(level);
							}}
						/>
					</ConversationColumn>
				</div>
			</div>
		</div>
	);
}
