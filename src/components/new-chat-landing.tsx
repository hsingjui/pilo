import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	ChatComposer,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer";
import { PI_SESSION_SUGGESTIONS } from "@/components/chat/chat-composer-suggestions";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { SessionHeader } from "@/components/chat/chat-session-header";
import {
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";
import { createChatSessionClient } from "@/lib/chat-session-client";
import { createPiCommandSuggestions } from "@/lib/pi-command-suggestions";
import { searchProjectFiles } from "@/lib/files";
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

const FILE_SUGGESTION_DEBOUNCE_MS = 180;

export function NewChatLanding({
	sessionId,
	onStartSession,
	onNewChat,
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
	sessionId: string;
	onStartSession: (
		submission: ChatSubmission,
		model: PiModel | null,
		thinkingLevel: PiThinkingLevel | null,
	) => void;
	onNewChat?: () => void;
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
	const [commandSuggestions, setCommandSuggestions] = useState<
		ComposerSuggestion[]
	>([]);
	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);
	const commandLoadingRef = useRef(false);
	const commandsLoadedRef = useRef(false);
	const modelRequestRef = useRef(0);
	const modelLoadingRef = useRef(false);
	const modelSelectionDirtyRef = useRef(false);
	const thinkingSelectionDirtyRef = useRef(false);
	const selectedModelKeyRef = useRef(
		modelKey(cachedModels?.defaultModel ?? null),
	);
	const composerSuggestions = useMemo(
		() => [
			...fileSuggestions,
			...PI_SESSION_SUGGESTIONS,
			...commandSuggestions,
		],
		[commandSuggestions, fileSuggestions],
	);

	const loadCommands = useCallback(async () => {
		if (!projectId || commandLoadingRef.current || commandsLoadedRef.current) {
			return;
		}
		commandLoadingRef.current = true;
		try {
			const client = createChatSessionClient(projectId, sessionId);
			await client.prepare();
			const result = await client.getPiCommands();
			setCommandSuggestions(createPiCommandSuggestions(result.commands));
			commandsLoadedRef.current = true;
		} catch (error) {
			console.warn("Failed to load Pi commands for new chat", error);
		} finally {
			commandLoadingRef.current = false;
		}
	}, [projectId, sessionId, setCommandSuggestions]);

	const handleSuggestionTrigger = useCallback(
		(trigger: "@" | "/" | null, query: string) => {
			fileSuggestionRequestRef.current += 1;
			const requestId = fileSuggestionRequestRef.current;
			if (fileSuggestionTimerRef.current !== null) {
				window.clearTimeout(fileSuggestionTimerRef.current);
				fileSuggestionTimerRef.current = null;
			}
			if (trigger === "/") {
				setFileSuggestions([]);
				void loadCommands();
				return;
			}
			if (trigger !== "@" || !projectId) {
				setFileSuggestions([]);
				return;
			}

			const normalizedQuery = query.trim();
			fileSuggestionTimerRef.current = window.setTimeout(() => {
				fileSuggestionTimerRef.current = null;
				void searchProjectFiles(projectId, normalizedQuery)
					.then((paths) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						setFileSuggestions(createFileSuggestions(paths, normalizedQuery));
					})
					.catch((error) => {
						if (fileSuggestionRequestRef.current !== requestId) return;
						console.warn("Failed to load file suggestions for new chat", error);
						setFileSuggestions([]);
					});
			}, FILE_SUGGESTION_DEBOUNCE_MS);
		},
		[loadCommands, projectId, setFileSuggestions],
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
		commandsLoadedRef.current = false;
		commandLoadingRef.current = false;
		fileSuggestionRequestRef.current += 1;
		if (fileSuggestionTimerRef.current !== null) {
			window.clearTimeout(fileSuggestionTimerRef.current);
			fileSuggestionTimerRef.current = null;
		}
		setCommandSuggestions([]);
		setFileSuggestions([]);
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

	const handleSubmit = useCallback(
		(submission: ChatSubmission) => {
			const command = submission.text.trim();
			if (command.startsWith("/")) {
				const commandName = command.slice(1).split(/\s+/, 1)[0];
				if (commandName === "new") {
					setDraft("");
					onNewChat?.();
					return;
				}
				if (commandName === "compact") {
					setDraft("");
					toast.info("当前没有可压缩的上下文");
					return;
				}
			}

			onStartSession(submission, selectedModel, selectedThinkingLevel);
		},
		[onNewChat, onStartSession, selectedModel, selectedThinkingLevel, setDraft],
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
							historyKey={projectId}
							onChange={setDraft}
							onSubmit={handleSubmit}
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
							suggestions={composerSuggestions}
							onSuggestionTrigger={handleSuggestionTrigger}
						/>
					</ConversationColumn>
				</div>
			</div>
		</div>
	);
}
