import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectWorkspacePanel } from "@/components/app/project-workspace-panel";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
	ChatComposer,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer";
import { SessionMentionScope } from "@/components/chat/session-mention-context";
import { piSessionSuggestions } from "@/components/chat/chat-composer-suggestions";
import { createFileSuggestions } from "@/components/chat/chat-file-suggestions";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { SessionHeader } from "@/components/chat/chat-session-header";
import {
	listenRuntimeEvents,
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/api/pi-runtime";
import { createPiCommandSuggestions } from "@/lib/chat/pi-command-suggestions";
import { searchProjectFiles, uploadChatFile } from "@/lib/api/files";
import {
	getNextPiScopeModel,
	getProjectScopeModels,
	getProjectScopeDefaultModel,
	findMatchingPiModel,
	isPiScopeCatalogResolved,
	getPiModelThinkingLevels,
	getPiQuickCycleThinkingLevel,
} from "@/lib/pi-model-selection";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsIncomplete,
	refreshProjectPiModels,
	subscribeProjectPiModels,
} from "@/lib/api/pi-models";
import { usePreferences } from "@/lib/preferences-provider";
import type { Project } from "@/lib/api/projects";
import type { ChatSubmission } from "@/lib/chat/chat-submission";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { promptEnhancementModel } from "@/lib/prompt-enhancement";
import { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
import { useProjectModelScope } from "@/lib/use-project-model-scope";
import { DraftProjectPicker } from "@/components/chat/draft-project-picker";

function modelKey(model: PiModel | null): string | null {
	return model ? `${model.provider}\0${model.id}` : null;
}

const FILE_SUGGESTION_DEBOUNCE_MS = 180;

const EMPTY_PROJECTS: Project[] = [];

export function NewChatLanding({
	onStartSession,
	onNewChat,
	onOpenTerminal,
	terminalRunning = false,
	terminalVisible = false,
	onNewTemporaryChat,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
	temporary = false,
	projectAvailable = true,
	project = null,
	projects = EMPTY_PROJECTS,
	onSwitchProject,
	readProjectDraft,
	writeProjectDraft,
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
	/** 临时会话草稿态：落地页顶栏显示临时标识。 */
	temporary?: boolean;
	projectAvailable?: boolean;
	project?: Project | null;
	/** 可切换的落点项目列表。 */
	projects?: Project[];
	onSwitchProject?: (projectId: string) => void;
	readProjectDraft?: (projectId: string) => string;
	writeProjectDraft?: (projectId: string, value: string) => void;
}) {
	const { t } = useTranslation();
	const { keyboardShortcuts } = usePreferences();
	const projectId = project?.id ?? null;
	const cachedModels = projectId ? getCachedProjectPiModels(projectId) : null;
	const scopeConfig = useProjectModelScope(tauriPiloClient, projectId ?? "");
	// 草稿优化按落点项目所属 Connection 的 Host 设置开关；默认关闭。
	const promptEnhancement = usePromptEnhancementSettings(
		tauriPiloClient,
		project?.connection.id ?? "",
	);
	useEffect(() => {
		if (!projectId) return;
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
	}, [projectId, scopeConfig.handleEvent]);
	const [modelCatalog, setModelCatalog] = useState(cachedModels);
	const [draft, setDraft] = useState(
		() => (projectId ? readProjectDraft?.(projectId) : "") ?? "",
	);
	const [models, setModels] = useState<PiModel[]>(cachedModels?.models ?? []);
	// 草稿只保存手动选择；项目默认随 Scope/目录加载派生，不写回用户选择。
	const [draftModel, setDraftModel] = useState<PiModel | null>(null);
	const [draftThinkingLevel, setDraftThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const [modelLoadState, setModelLoadState] = useState<
		"idle" | "loading" | "ready" | "error"
	>(cachedModels ? "ready" : "idle");
	const [modelError, setModelError] = useState<string | null>(null);
	const commandSuggestions = useMemo(
		() =>
			createPiCommandSuggestions(
				modelCatalog?.projectId === projectId
					? (modelCatalog.commands ?? [])
					: [],
			),
		[modelCatalog, projectId],
	);
	const [fileSuggestions, setFileSuggestions] = useState<ComposerSuggestion[]>(
		[],
	);
	const fileSuggestionTimerRef = useRef<number | null>(null);
	const fileSuggestionRequestRef = useRef(0);
	const modelRequestRef = useRef(0);
	const modelLoadingRef = useRef(false);
	const hasScopeDefault = Boolean(
		scopeConfig.scope?.models?.some((entry) => entry.isDefault),
	);
	const projectScopeDefaultModel = useMemo(
		() =>
			getProjectScopeDefaultModel(
				modelCatalog?.projectId === projectId ? modelCatalog.models : [],
				scopeConfig.scope,
			),
		[modelCatalog, projectId, scopeConfig.scope],
	);
	const initialModel = draftModel ?? projectScopeDefaultModel;
	const draftConfigUnresolved =
		!draftModel &&
		(!scopeConfig.scope || (hasScopeDefault && modelLoadState !== "ready"));
	const selectedModel = draftConfigUnresolved
		? null
		: (initialModel ?? modelCatalog?.defaultModel ?? null);
	const selectedThinkingLevel = draftConfigUnresolved
		? null
		: (draftThinkingLevel ??
			(draftModel
				? (draftModel.defaultThinkingLevel ?? null)
				: projectScopeDefaultModel
					? getPiQuickCycleThinkingLevel(projectScopeDefaultModel)
					: (modelCatalog?.defaultThinkingLevel ?? null)));
	const draftConfigError = draftModel
		? null
		: (scopeConfig.error ?? (hasScopeDefault ? modelError : null));
	const draftConfigPending =
		!draftModel &&
		(scopeConfig.loading ||
			Boolean(draftConfigError) ||
			(hasScopeDefault && modelLoadState !== "ready"));
	const composerSuggestions = useMemo(
		() => [
			...fileSuggestions,
			...piSessionSuggestions(t),
			...commandSuggestions,
		],
		[commandSuggestions, fileSuggestions, t],
	);
	const updateDraft = useCallback(
		(value: string) => {
			setDraft(value);
			if (projectId) writeProjectDraft?.(projectId, value);
		},
		[projectId, setDraft, writeProjectDraft],
	);

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
		[projectId, setFileSuggestions],
	);

	const applyModelSnapshot = useCallback(
		(snapshot: NonNullable<ReturnType<typeof getCachedProjectPiModels>>) => {
			setModelCatalog(snapshot);
			setModels(snapshot.models);
			setDraftModel((current) =>
				current
					? (findMatchingPiModel(snapshot.models, current) ?? current)
					: null,
			);
			setModelLoadState("ready");
			setModelError(null);
		},
		[setModelError, setModelLoadState, setModels, setDraftModel],
	);

	const loadModels = useCallback(
		async (force = false) => {
			if (!projectId || modelLoadingRef.current) return;
			const cached = getCachedProjectPiModels(projectId);
			if (!force && cached && !isProjectPiModelsIncomplete(cached)) {
				applyModelSnapshot(cached);
				return;
			}
			const requestId = ++modelRequestRef.current;
			modelLoadingRef.current = true;
			setModelLoadState("loading");
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

	/* oxlint-disable react/set-state-in-effect -- Changing project identity clears manual choices before resolving that project's defaults. */
	useEffect(() => {
		fileSuggestionRequestRef.current += 1;
		if (fileSuggestionTimerRef.current !== null) {
			window.clearTimeout(fileSuggestionTimerRef.current);
			fileSuggestionTimerRef.current = null;
		}
		setFileSuggestions([]);
		const cached = projectId ? getCachedProjectPiModels(projectId) : null;
		setModelCatalog(cached);
		setModels(cached?.models ?? []);
		setDraftModel(null);
		setDraftThinkingLevel(null);
		setModelLoadState(cached ? "ready" : "idle");
		setModelError(null);
		setDraft(projectId ? (readProjectDraft?.(projectId) ?? "") : "");
	}, [projectId, readProjectDraft]);
	/* oxlint-enable react/set-state-in-effect */

	useEffect(() => {
		if (!projectId) return;
		let disposed = false;
		const unsubscribe = subscribeProjectPiModels(projectId, applyModelSnapshot);
		void hydrateProjectPiModels()
			.then(() => {
				if (disposed) return;
				const cached = getCachedProjectPiModels(projectId);
				if (cached) applyModelSnapshot(cached);
				if (!cached || isProjectPiModelsIncomplete(cached)) {
					void loadModels();
				}
			})
			.catch((error) => {
				if (disposed) return;
				console.warn("Failed to hydrate Pi models", error);
				void loadModels();
			});
		return () => {
			disposed = true;
			unsubscribe();
			modelRequestRef.current += 1;
			modelLoadingRef.current = false;
		};
	}, [applyModelSnapshot, loadModels, projectId]);

	const selectDraftModel = (
		model: PiModel,
		thinkingLevel: PiThinkingLevel | null = null,
	) => {
		setDraftModel(model);
		setDraftThinkingLevel(thinkingLevel);
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

	const availableModels =
		modelCatalog?.projectId === projectId ? modelCatalog.models : [];
	const catalogReady =
		modelCatalog?.projectId === projectId &&
		(scopeConfig.scope?.models != null ||
			isPiScopeCatalogResolved(availableModels));
	const scopeModels = useMemo(
		() =>
			catalogReady && modelCatalog
				? getProjectScopeModels(modelCatalog.models, scopeConfig.scope)
				: [],
		[catalogReady, modelCatalog, scopeConfig.scope],
	);

	useKeyboardShortcut(
		keyboardShortcuts["cycle-scoped-model"],
		() => {
			if (!scopeConfig.scope || scopeConfig.error) return;
			if (!catalogReady) {
				void loadModels();
				return;
			}
			const nextModel = getNextPiScopeModel(scopeModels, selectedModel);
			if (!nextModel) return;
			selectDraftModel(nextModel, nextModel.scopeThinkingLevel ?? null);
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
					updateDraft("");
					onNewChat?.();
					return;
				}
				if (commandName === "compact") {
					updateDraft("");
					toast.info(t("chat.noCompaction"));
					return;
				}
			}

			if (draftConfigPending) return;
			// 手动选择 > 项目 Scope 默认项 > Pi 自己的默认配置；目录缓存不参与启动选择。
			onStartSession(
				submission,
				initialModel,
				initialModel ? selectedThinkingLevel : draftThinkingLevel,
			);
			updateDraft("");
		},
		[
			onNewChat,
			onStartSession,
			draftConfigPending,
			draftThinkingLevel,
			initialModel,
			selectedThinkingLevel,
			updateDraft,
			t,
		],
	);

	return (
		<SessionMentionScope connectionId={project?.connection.id ?? ""}>
			<div className="@container relative flex h-full min-w-0 flex-col">
				<SessionHeader
					project={project}
					overlay
					temporary={temporary}
					onOpenTerminal={onOpenTerminal}
					terminalRunning={terminalRunning}
					terminalVisible={terminalVisible}
					onNewTemporaryChat={onNewTemporaryChat}
					onExpandSidebar={onExpandSidebar}
					reserveWindowControls={reserveWindowControls}
					sidebarCollapsed={sidebarCollapsed}
				/>
				<ProjectWorkspacePanel project={project} headerOverlay>
					<div className="flex min-h-0 w-full flex-1 flex-col">
						<ConversationColumn className="flex flex-1 items-center justify-center">
							<ChatEmptyHero />
						</ConversationColumn>
					</div>
					<div className="relative -mt-4 w-full shrink-0 pb-4">
						<ConversationColumn className="relative">
							<DraftProjectPicker
								projects={projects}
								project={project}
								onSwitchProject={onSwitchProject}
							/>
							<ChatComposer
								value={draft}
								historyKey={projectId}
								onUploadFile={
									projectId
										? (file) => uploadChatFile(projectId, file)
										: undefined
								}
								onEnhancePrompt={
									promptEnhancement.settings?.enabled && projectId
										? (draftValue) =>
												tauriPiloClient.enhancePrompt(
													projectId,
													draftValue,
													promptEnhancementModel(selectedModel),
												)
										: undefined
								}
								onChange={updateDraft}
								onSubmit={handleSubmit}
								disabled={draftConfigPending}
								statusError={draftConfigError}
								models={models}
								modelScope={{
									...scopeConfig,
									models: scopeModels,
									availableModels,
									catalogReady,
								}}
								canEditScope={projectAvailable && Boolean(project)}
								selectedModel={selectedModel}
								modelLoading={
									modelLoadState === "loading" ||
									(draftConfigUnresolved && scopeConfig.loading)
								}
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
								onThinkingChange={setDraftThinkingLevel}
								suggestions={composerSuggestions}
								onSuggestionTrigger={handleSuggestionTrigger}
							/>
						</ConversationColumn>
					</div>
				</ProjectWorkspacePanel>
			</div>
		</SessionMentionScope>
	);
}
