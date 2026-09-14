import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { PiLogo } from "@/components/pi-logo";
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
import { cn } from "@/lib/utils";
import { IS_MACOS } from "@/components/title-bar";
import type { Project } from "@/lib/projects";
import type { ChatSubmission } from "@/lib/chat-submission";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { Button } from "@/ui";

function modelKey(model: PiModel | null): string | null {
	return model ? `${model.provider}\0${model.id}` : null;
}

export function NewChatLanding({
	onStartSession,
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
				if (!cached || isProjectPiModelsStale(cached)) void loadModels();
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
			{/* 与 Lody 一样，桌面拖拽条悬浮在内容之上，不占 Landing 的垂直布局。 */}
			<div
				aria-hidden="true"
				data-tauri-drag-region="deep"
				className={cn(
					"absolute inset-x-0 top-0 z-10 h-11",
					reserveWindowControls && "pr-[7.75rem]",
				)}
			/>
			{sidebarCollapsed && (
				<Button
					variant="ghost"
					size="icon"
					className={cn(
						"absolute z-20 size-7 shrink-0",
						IS_MACOS ? "left-24 top-[9px]" : "left-3 top-2",
					)}
					aria-label="展开侧边栏"
					onClick={onExpandSidebar}
				>
					<PanelLeft className="size-4" />
				</Button>
			)}
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-4">
				<div className="flex flex-col items-center justify-center gap-3 text-center">
					<PiLogo className="h-16 w-16 text-foreground" />
					<h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
						今天想做点什么？
					</h1>
				</div>
			</div>
			<div className="mx-auto w-full max-w-[46rem] px-3 pb-2 sm:px-4">
				<ChatComposer
					variant="landing"
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
			</div>
		</div>
	);
}
