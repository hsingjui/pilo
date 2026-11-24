import {
	type Accessor,
	cleanup,
	computed,
	effect,
	type JSX,
	platform,
	signal,
	token,
	untracked,
	View,
} from "nsh";
import { currentWindow } from "nsh/desktop";

import type { Project } from "@shared/api/projects-types";
import type { ChatConversationImage } from "@shared/chat/conversation-types";
import type { WorkspaceLineRange } from "@shared/project-workspace";

import { CacheKeepAliveNotice } from "../chat/cache-keep-alive-notice";
import { ChatAgentActivityIndicator } from "../chat/chat-agent-activity";
import { ChatImageLightbox } from "../chat/chat-image-lightbox";
import { ChatMessageList } from "../chat/chat-message-list";
import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import {
	ChatMediaActions,
	type ChatImagePreview,
} from "../chat/chat-media-actions";
import { ChatReadingFont, chatReadingFont } from "../chat/chat-reading-font";
import { ChatTodoCapsule } from "../chat/chat-todo-capsule";
import { readChatUserImage } from "../chat/chat-user-image-cache";
import {
	ConversationColumn,
	ConversationColumnLayout,
} from "../chat/conversation-column";
import { DEFAULT_CHAT_REM } from "../chat/layout";
import { ChatComposer, ChatComposerSkeleton } from "../composer/chat-composer";
import {
	createComposerAssistance,
	type ComposerAssistanceClient,
} from "../composer/composer-assistance";
import type { ComposerStore } from "../composer/composer-store";
import { activeProject, isTemporarySessionId } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type { ChatRunConfigStore } from "../state/chat-run-config";
import type { ChatTranscriptStore } from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { defaultKeyboardShortcuts } from "@shared/keyboard-shortcuts-core";
import type {
	KeyboardShortcutMap,
	ShortcutCommandId,
} from "@shared/keyboard-shortcuts-types";
import { getNextPiModel } from "@shared/pi-model-selection";
import { bindAppShortcut, type AppShortcutBinding } from "../shortcuts";
import {
	SettingsDialog,
	type SettingsClient,
} from "../settings/settings-dialog";
import { createRemoteStatus, RemoteDialog } from "../settings/remote-dialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ErrorState } from "../ui/state-view";
import { AppToaster, AppToasts, AppToastStack } from "./app-toasts";
import { followSavedAppearance } from "./appearance";
import { CommandPalette } from "./command-palette";
import type { DesktopNotificationsApi } from "./desktop-notifications";
import type { DesktopShell } from "./desktop-shell";
import { createDesktopUpdate, type DesktopUpdate } from "./desktop-update";
import { t } from "./i18n";
import { UpdateDialog } from "./update-dialog";
import { AddProjectDialog, type AddProjectApi } from "./add-project-dialog";
import { FilePreviewLayer } from "./file-preview-view";
import {
	GitWorkspaceLayer,
	type GitWorkspaceClient,
} from "./git-workspace-view";
import { SessionLanding } from "./landing";
import { openChatTarget } from "./open-chat";
import {
	canOpenToolFilePath,
	openMarkdownFileLink,
	openToolFilePath,
	type OpenFileLinkClient,
} from "./open-file-link";
import { HeaderActions } from "./header-actions";
import { SessionHeader } from "./session-header";
import { TerminalLayer } from "./terminal-view";
import type { ProjectNativeApp } from "../client/nsh-pilo-client";
import type { TerminalStore } from "../state/terminal-store";
import { WorkspaceStore } from "../state/workspace-store";
import {
	NOTICE_MS as FORK_NOTICE_MS,
	type SessionForker,
} from "./session-fork";
import { createSidebarLayout } from "./sidebar-layout";
import { SidebarPanel, StartupSidebar } from "./sidebar-panel";
import { SidebarSettingsStore } from "./sidebar-settings";

/** The title bar's height; the system centers its window controls in it. */
const TITLE_BAR_HEIGHT = 44;

export interface AppShellProps {
	/** The app state the shell shows; whoever mounts the shell starts it. */
	store: AppStore;
	/** The open session's transcript; whoever mounts the shell keeps it open. */
	chat: Pick<
		ChatTranscriptStore,
		"state" | "messages" | "refresh" | "loadRange"
	>;
	/** The open session's composer; whoever mounts the shell targets it. */
	composer: ComposerStore;
	assistanceClient?: ComposerAssistanceClient;
	/** Reads a project-relative image's bytes (reply `![…](path)` previews). */
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	/** Reads an image of a saved user message from its session file. */
	readHistoryImage?: (
		projectId: string,
		sessionPath: string,
		imageId: string,
	) => Promise<Uint8Array>;
	/** Prompts the user to save an image from the preview lightbox. */
	saveImage?: (suggestedName: string, bytes: Uint8Array) => Promise<boolean>;
	/** Opens a file link via the runtime (returns preview text or launches the system app). */
	openFileLink?: OpenFileLinkClient;
	/** Native Git status/diff reader for the desktop-only Git workspace tab. */
	git?: GitWorkspaceClient;
	/** Per-project open file preview and Git tabs; created automatically when `openFileLink` or `git` is given. */
	workspace?: WorkspaceStore;
	/** What a project file link in a reply does when pressed (overrides default workspace handling). */
	onFileLink?: (link: ChatMarkdownFileLink) => void;
	/** The open session's run configuration; a header shows it when present. */
	runConfig?: Pick<
		ChatRunConfigStore,
		| "state"
		| "setModel"
		| "setThinkingLevel"
		| "cycleScopeModel"
		| "scopeModels"
		| "catalogReady"
	>;
	/** The active project's model catalog, for the header's picker. */
	catalog?: Pick<ModelCatalogStore, "state" | "refresh" | "saveScope">;
	/** Renames a saved session in the index. */
	onRenameSession?: (
		projectId: string,
		sessionPath: string,
		title: string,
	) => void;
	/** Forks the open session at an assistant message. */
	forker?: Pick<SessionForker, "state" | "forkAssistant" | "dismissNotice">;
	/** Searches saved message text for the command palette. */
	searchSessions?: Pick<NshPiloClient, "searchSessions">;
	/** The settings panes' saves and reads; no settings entry without it. */
	settings?: SettingsClient;
	/** The client calls the add-project dialog needs; `undefined` hides it. */
	projectClient?: AddProjectApi;
	desktop?: DesktopShell;
	notifications?: DesktopNotificationsApi;
	/** Desktop updater state shared by the sidebar button, About pane, and update dialog. */
	update?: DesktopUpdate;
	/** The project terminals the title bar opens in tabs; none without it. */
	terminals?: TerminalStore;
	/** Opens a project in Finder, Ghostty and the like, for quick open. */
	openProjectInApp?: (
		projectId: string,
		app: ProjectNativeApp,
		path?: string,
	) => Promise<void>;
	/** The sidebar's stored settings, when the launch has already loaded them. */
	sidebarSettings?: SidebarSettingsStore;
	/** Shared app toast queue; a private one is created if omitted. */
	toasts?: AppToasts;
}

export function AppShell(props: AppShellProps) {
	const { store, chat, composer } = props;
	const status = computed(() => store.state().status);
	const project = computed(() => activeProject(store.state()));
	const hasProject = computed(() => project() !== null);
	const sessionOpen = computed(() => store.state().navigation.session !== null);
	const toasts = props.toasts ?? new AppToasts();
	const workspace =
		props.workspace ??
		(props.openFileLink || props.git ? new WorkspaceStore() : undefined);
	const previewImage = signal<ChatImagePreview | null>(null);
	const fileOpenContext = workspace
		? {
				project,
				workspace,
				openFileLink: props.openFileLink,
				readProjectImage: props.readProjectImage,
				openImage: (image: ChatImagePreview) => previewImage.set(image),
				toasts,
				onFileActivated: () => props.terminals?.select(null),
			}
		: null;
	const handleFileLink =
		props.onFileLink ??
		(fileOpenContext
			? (link: ChatMarkdownFileLink) =>
					openMarkdownFileLink(fileOpenContext, link)
			: undefined);
	const mediaActions = {
		openImage: (image: ChatImagePreview) => previewImage.set(image),
		sessionMentions: () => composer.sessionsByValue(),
		readUserImage: (image: ChatConversationImage) => {
			const session = store.state().navigation.session;
			const config = props.runConfig?.state();
			const sessionPath =
				session?.sessionPath ||
				(config &&
				config.sessionKey === chatSessionKey() &&
				config.projectId === session?.projectId
					? config.session?.sessionPath
					: undefined);
			const read = props.readHistoryImage;
			return readChatUserImage(
				image,
				session && sessionPath && read
					? { projectId: session.projectId, sessionPath, read }
					: null,
			);
		},
		project,
		onFileLink: handleFileLink,
		openFile: fileOpenContext
			? (path: string, lineRange?: WorkspaceLineRange) =>
					openToolFilePath(fileOpenContext, path, lineRange)
			: undefined,
	};
	/** The open session's index entry, for its title and Pi session id. */
	const openSessionEntry = computed(() => {
		const state = store.state();
		const open = state.navigation.session;
		if (!open?.sessionPath) return null;
		return (
			state.sessionIndexes[open.projectId]?.sessions.find(
				(entry) => entry.sessionPath === open.sessionPath,
			) ?? null
		);
	});
	/** The open chat is a temporary one, which Pi does not save. */
	const temporaryOpen = computed(() =>
		isTemporarySessionId(store.state().navigation.session?.sessionId),
	);
	/** An explicit rename wins; otherwise prefer Pi's current name. */
	const openSessionTitle = () =>
		openSessionEntry()?.titleOverride ??
		props.runConfig?.state()?.session?.name ??
		openSessionEntry()?.name ??
		openSessionEntry()?.firstUserMessagePreview ??
		(temporaryOpen() ? t("app.temporaryChat") : t("app.newChat"));
	/** The project's terminal shown in place of its chat, if any. */
	const shownTerminal = computed(
		() => props.terminals?.activeTab(project()?.id) ?? null,
	);
	/** The project whose Git workspace tab is shown in place of its chat, if any. */
	const shownGitProjectId = computed(() => {
		if (shownTerminal() || !props.git || !workspace) return null;
		const currentId = project()?.id ?? null;
		return currentId && workspace.isGitActive(currentId) ? currentId : null;
	});
	/** The project's file preview shown in place of its chat, if any. */
	const shownFile = computed(() =>
		shownTerminal() || shownGitProjectId()
			? null
			: (workspace?.activeFile(project()?.id) ?? null),
	);
	const paletteOpen = signal(false);
	const settingsOpen = signal(false);
	const appShortcutBindings = signal<
		Partial<Record<ShortcutCommandId, AppShortcutBinding>>
	>({});
	const composerAppShortcuts = computed(() =>
		Object.values(appShortcutBindings()),
	);
	const registeredShortcuts = computed<Partial<KeyboardShortcutMap>>(() =>
		Object.fromEntries(
			Object.entries(appShortcutBindings()).map(([id, binding]) => [
				id,
				binding.shortcut,
			]),
		),
	);
	const addProjectOpen = signal(false);
	const addProjectConnection = signal<string | null>(null);
	const remoteOpen = signal(false);
	const ownedUpdate =
		props.update || !props.settings
			? null
			: createDesktopUpdate({ restart: props.desktop?.restart });
	if (ownedUpdate) cleanup(() => ownedUpdate.dispose());
	const update = props.update ?? ownedUpdate ?? undefined;
	const modalOpen = () =>
		settingsOpen() ||
		addProjectOpen() ||
		remoteOpen() ||
		Boolean(update?.dialogOpen()) ||
		previewImage() !== null;
	const defaults = defaultKeyboardShortcuts(platform.os === "macos");
	const shortcuts = computed(
		() => store.state().preferences?.values.keyboardShortcuts ?? defaults,
	);
	const sessionShortcuts = () =>
		modalOpen() || paletteOpen() ? null : shortcuts();
	const sidebarSettings = props.sidebarSettings ?? new SidebarSettingsStore();
	if (!sidebarSettings.loaded()) void sidebarSettings.load();
	const sidebarLayout = createSidebarLayout(sidebarSettings);
	const collapsed = sidebarLayout.collapsed;
	// The expand button fades in once the sidebar has collapsed, and out as
	// it opens, as the WebUI header's button does.
	const expandMounted = signal(false);
	const expandVisible = signal(false);
	effect(() => {
		if (collapsed()) {
			expandMounted.set(true);
			const timer = setTimeout(() => expandVisible.set(true), 0);
			return () => clearTimeout(timer);
		}
		expandVisible.set(false);
		const timer = setTimeout(() => expandMounted.set(false), 200);
		return () => clearTimeout(timer);
	});
	const narrowConversation = signal(false);
	const claudeTheme = computed(
		() => store.state().themeSettings?.themeFamily === "claude",
	);
	const conversationLayout = computed(() => ({
		claude: claudeTheme(),
		narrow: narrowConversation(),
	}));
	// Only a change of the font settings reaches the chat's texts.
	const readingFontSize = computed(
		() => store.state().preferences?.values.readingFontSize,
	);
	const readingFontFamily = computed(
		() => store.state().preferences?.values.readingFontFamily,
	);
	const readingFont = computed(() =>
		chatReadingFont({
			readingFontSize: readingFontSize(),
			readingFontFamily: readingFontFamily(),
		}),
	);
	const chatTarget = computed(() => openChatTarget(store.state()), {
		equals: (previous, next) =>
			previous?.sessionKey === next?.sessionKey &&
			previous?.projectId === next?.projectId &&
			previous?.sessionPath === next?.sessionPath,
	});
	const chatSessionKey = computed(() => chatTarget()?.sessionKey ?? null);
	effect(() => {
		const target = chatTarget();
		untracked(() => composer.setTarget(target));
	});
	const assistance =
		props.assistanceClient &&
		createComposerAssistance(props.assistanceClient, store, () => {
			const target = composer.target();
			const sessionKey = target?.sessionKey ?? null;
			const draft = composer.state();
			const config = props.runConfig?.state();
			const currentConfig = config?.sessionKey === sessionKey ? config : null;
			const transcript = chat.state();
			const currentProject = project();
			return {
				projectId: target?.projectId ?? null,
				connectionId:
					currentProject && currentProject.id === target?.projectId
						? currentProject.connection.id
						: "",
				sessionKey,
				sessionId: currentConfig?.session?.sessionId ?? null,
				draft: draft.value,
				hasAttachments: draft.images.length > 0,
				active: status().type === "ready" && sessionKey === chatSessionKey(),
				busy:
					draft.sending ||
					composer.running() ||
					Boolean(transcript.conversation?.active),
				blocked:
					draft.composing ||
					composer.readOnly() ||
					modalOpen() ||
					paletteOpen(),
				model: currentConfig?.model ?? null,
				loading:
					transcript.sessionKey !== sessionKey || transcript.status !== "ready",
			};
		});
	const cacheNoticeSessions = computed(() => {
		const sessionKey = chatSessionKey();
		return sessionKey && assistance ? [sessionKey] : [];
	});
	const cacheStatus = (sessionKey: string) =>
		store.state().chatSessions.find((chat) => chat.sessionKey === sessionKey)
			?.cacheKeepAlive ?? null;
	const refreshCacheStatus = () => {
		const sessionKey = chatSessionKey();
		if (
			sessionKey &&
			status().type === "ready" &&
			untracked(store.state).chatSessions.some(
				(held) => held.sessionKey === sessionKey,
			)
		) {
			void store.refreshChatSession(sessionKey);
		}
	};
	if (assistance) effect(refreshCacheStatus);

	// Without an open session the workspace holds a new chat in the active
	// project, as the WebUI landing does, so its composer is always there.
	effect(() => {
		const state = store.state();
		if (state.status.type !== "ready" || state.navigation.session) return;
		const project = activeProject(state);
		if (project) {
			untracked(() =>
				store.selectProject(project.id, { focusComposer: false }),
			);
		}
	});
	/** Keep the mounted header when a reply streams or the sidebar index changes. */
	const showSessionHeader = computed(() => {
		if (status().type !== "ready" || !sessionOpen()) return false;
		return (
			store.state().navigation.session?.sessionId === undefined ||
			chat.messages().length > 0
		);
	});
	/** The title bar holds the chat's tab, or at least the project's actions. */
	const headerShown = computed(
		() =>
			status().type === "ready" &&
			(showSessionHeader() || temporaryOpen() || project() !== null),
	);
	followSavedAppearance(store.state);
	// A fork's outcome joins the app's toasts once per notice.
	let forkNotice: number | null = null;
	effect(() => {
		const notice = props.forker?.state().notice;
		if (!notice || notice.id === forkNotice) return;
		forkNotice = notice.id;
		untracked(() =>
			toasts.show({
				variant: notice.kind,
				title: notice.title,
				description: notice.description,
				timeout: FORK_NOTICE_MS,
			}),
		);
	});
	// The app draws its own title bar: the sidebar and the main area reach
	// the window's top edge, beside the system's window controls.
	const window = currentWindow();
	if (assistance)
		cleanup(
			window.on("focusChange", ({ focused }) => {
				if (!focused) return;
				assistance.refreshSettings();
				refreshCacheStatus();
			}),
		);
	window.set({ titleBar: { style: "hidden", height: TITLE_BAR_HEIGHT } });
	const titleBar = () => window.titleBar();
	const barHeight = () => titleBar().height || TITLE_BAR_HEIGHT;
	const newChat = () => {
		const current = activeProject(store.state());
		props.terminals?.select(null);
		workspace?.selectChat(current?.id);
		if (current) store.selectProject(current.id);
		else if (props.projectClient) openAddProject(null);
	};
	const newTemporaryChat = (projectId: string) => {
		props.terminals?.select(null);
		workspace?.selectChat(projectId);
		store.selectTemporary(projectId);
	};
	const openTerminal = (projectId: string) => {
		workspace?.selectChat(projectId);
		void props.terminals?.open(projectId).catch((error: unknown) => {
			console.error(t("terminal.openFailed"), error);
			toasts.show({
				variant: "error",
				title: t("terminal.openFailed"),
				description: error instanceof Error ? error.message : String(error),
			});
		});
	};
	if (props.terminals || workspace) {
		const terminals = props.terminals;
		const projects = computed(() => store.state().projects);
		effect(() => {
			const ids = projects().map(({ id }) => id);
			untracked(() => {
				terminals?.reconcileProjects(new Set(ids));
				workspace?.reconcileProjects(ids);
			});
		});
	}
	const showChat = (projectId?: string) => {
		props.terminals?.select(null);
		workspace?.selectChat(projectId);
	};
	// Opening another chat also switches the workspace for non-sidebar navigation.
	effect(() => {
		chatSessionKey();
		const currentProjectId = untracked(project)?.id;
		untracked(() => showChat(currentProjectId));
	});
	// A new-chat action can also reuse the current draft without navigating.
	effect(() => {
		if (store.newChatFocus()) untracked(() => showChat(project()?.id));
	});
	const focusRequest = {
		sessionKey: () =>
			modalOpen() ||
			paletteOpen() ||
			shownTerminal() ||
			shownGitProjectId() ||
			shownFile()
				? null
				: store.newChatFocus(),
		handled: () => store.clearNewChatFocus(),
	};
	const openAddProject = (connectionId: string | null) => {
		addProjectConnection.set(connectionId ?? project()?.connection.id ?? null);
		addProjectOpen.set(true);
	};
	const cycleModel = (scoped: boolean) => {
		const runConfig = props.runConfig;
		const config = runConfig?.state();
		const catalog = props.catalog?.state();
		const draft = composer.state();
		if (
			!runConfig ||
			!config?.ready ||
			config.sessionKey !== chatSessionKey() ||
			config.changing ||
			config.compacting ||
			composer.running() ||
			composer.readOnly() ||
			draft.sending ||
			draft.composing ||
			chat.state().status !== "ready" ||
			catalog?.projectId !== config.projectId ||
			!catalog.loaded ||
			catalog.refreshing
		)
			return;
		if (!catalog.catalog) {
			void props.catalog?.refresh();
			return;
		}
		if (scoped) {
			void runConfig.cycleScopeModel();
			return;
		}
		const next = getNextPiModel(catalog.catalog.models, config.model);
		if (next) void runConfig.setModel(next);
	};
	// Native keymaps run before a focused view's key capture, including the recorder.
	effect(() => {
		if (modalOpen()) {
			appShortcutBindings.set({});
			return;
		}
		const map = shortcuts();
		const bound: Partial<Record<ShortcutCommandId, AppShortcutBinding>> = {};
		const bind = (id: ShortcutCommandId, handler: () => void) => {
			const binding = bindAppShortcut(id, map[id] ?? defaults[id], handler);
			if (!binding) return;
			cleanup(binding.dispose);
			bound[id] = binding;
		};
		bind("open-command-palette", () => paletteOpen.update((open) => !open));
		bind("new-chat", () => {
			if (!paletteOpen() && status().type === "ready") newChat();
		});
		if (props.settings)
			bind("open-settings", () => {
				paletteOpen.set(false);
				settingsOpen.set(true);
			});
		bind("toggle-sidebar", () => sidebarLayout.setCollapsed(!collapsed()));
		if (
			props.runConfig &&
			props.catalog &&
			!paletteOpen() &&
			sessionOpen() &&
			// A shell takes Ctrl+P and the like while its terminal is in front.
			!shownTerminal()
		) {
			bind("cycle-model", () => cycleModel(false));
			bind("cycle-scoped-model", () => cycleModel(true));
		}
		appShortcutBindings.set(bound);
	});
	const client = props.settings;
	const remoteStatus = client ? createRemoteStatus(client, remoteOpen) : null;
	const defaultWorkspaceShown = () =>
		store.state().preferences?.values.defaultWorkspaceVisibility ?? {};
	const expandButton = () => (
		<View
			class={`absolute top-0 bottom-0 z-10 justify-center transition-opacity duration-200 ease-out ${
				expandVisible() ? "opacity-100 delay-200" : "opacity-0"
			}`}
			style={{
				left: titleBar().left > 0 ? titleBar().left + 6 : 6,
				pointerEvents: collapsed() ? "auto" : "none",
			}}
		>
			<Button
				testID="sidebar-expand"
				variant="ghost"
				size="icon"
				class="size-7 shrink-0"
				accessibilityLabel={t("navigation.expandSidebar")}
				onPress={() => sidebarLayout.setCollapsed(false)}
			>
				<Icon name="PanelLeft" size={16} color={token("muted-foreground")} />
			</Button>
		</View>
	);
	/** A page of the workspace that is not a chat, in its middle. */
	const centered = (page: JSX.Element) => (
		<View class="flex-1 items-center justify-center gap-2 p-6">{page}</View>
	);
	const layout = () => (
		<View class="flex-1 flex-row">
			<SidebarPanel
				store={store}
				settings={sidebarSettings}
				layout={sidebarLayout}
				listState={() => {
					switch (status().type) {
						case "starting":
							return "loading";
						case "ready":
							return sidebarSettings.loaded() ? "ready" : "loading";
						default:
							return "hidden";
					}
				}}
				titleBar={() => ({ height: barHeight(), left: titleBar().left })}
				onSearch={() => paletteOpen.set(true)}
				onNewChat={newChat}
				onSelectChat={showChat}
				onOpenSettings={client ? () => settingsOpen.set(true) : undefined}
				update={update}
				remote={
					remoteStatus
						? {
								running: remoteStatus.running,
								onOpen: () => remoteOpen.set(true),
							}
						: undefined
				}
				theme={() => store.state().themeSettings?.theme ?? "system"}
				onTheme={
					client
						? (theme) =>
								void client
									.saveThemeSettings({ theme })
									.catch((error: unknown) => {
										console.error(t("settings.themeSaveFailed"), error);
									})
						: undefined
				}
				defaultWorkspaceShown={defaultWorkspaceShown}
				onDefaultWorkspaceShown={
					client
						? (connectionId, shown) =>
								void client
									.savePreferences({
										defaultWorkspaceVisibility: { [connectionId]: shown },
									})
									.catch((error: unknown) => {
										console.error("Saving the default workspace failed", error);
									})
						: undefined
				}
				onAddProject={props.projectClient ? openAddProject : undefined}
				onRemoveConnection={
					client
						? (connection) => {
								const removal =
									connection.kind.type === "wsl"
										? client.removeWslConnection(connection.id)
										: connection.kind.type === "ssh"
											? client.removeSshConnection(connection.id)
											: null;
								void removal?.catch((error: unknown) => {
									console.error(t("project.removeConnectionFailed"), error);
								});
							}
						: undefined
				}
			/>
			<View
				testID="main"
				class="relative min-w-0 flex-1"
				onLayout={({ bounds }) =>
					narrowConversation.set(bounds.size.width < 40 * DEFAULT_CHAT_REM)
				}
			>
				<View
					testID="main-title-bar"
					desktop={{ windowDrag: true }}
					class="relative flex-row items-center px-2"
					style={{
						height: barHeight(),
						paddingLeft: collapsed() ? titleBar().left + 8 : 8,
						paddingRight: titleBar().right + 8,
					}}
				>
					{() => (expandMounted() ? expandButton() : null)}
					{() =>
						headerShown() ? (
							<SessionHeader
								logoHidden={collapsed}
								showTitle={() => showSessionHeader() || temporaryOpen()}
								temporary={temporaryOpen}
								title={openSessionTitle}
								sessionId={() =>
									props.runConfig?.state()?.session?.sessionId ??
									openSessionEntry()?.piSessionId ??
									null
								}
								sessionPath={() =>
									props.runConfig?.state()?.session?.sessionPath ??
									store.state().navigation.session?.sessionPath ??
									null
								}
								onRename={
									props.onRenameSession
										? (title) => {
												const session = store.state().navigation.session;
												if (session?.sessionPath)
													props.onRenameSession?.(
														session.projectId,
														session.sessionPath,
														title,
													);
											}
										: undefined
								}
								git={
									workspace && props.git
										? {
												open: () => workspace.isGitOpen(project()?.id),
												active: () => shownGitProjectId() !== null,
												onSelect: () => {
													const current = project();
													if (!current) return;
													props.terminals?.select(null);
													workspace.openGit(current.id);
												},
												onClose: () => {
													const current = project();
													if (current) workspace.closeGit(current.id);
												},
											}
										: undefined
								}
								files={
									workspace
										? {
												tabs: () => workspace.files(project()?.id),
												activePath: () => shownFile()?.file.path ?? null,
												onSelect: (path) => {
													const current = project();
													if (!current) return;
													props.terminals?.select(null);
													workspace.selectFile(current.id, path);
												},
												onClose: (path) => {
													const current = project();
													if (current) workspace.closeFile(current.id, path);
												},
											}
										: undefined
								}
								onSelectChat={() => {
									props.terminals?.select(null);
									workspace?.selectChat(project()?.id);
								}}
								terminals={
									props.terminals
										? {
												tabs: () =>
													props.terminals?.projectTabs(project()?.id) ?? [],
												activeId: () => shownTerminal()?.id ?? null,
												onSelect: (id) => {
													if (id !== null) workspace?.selectChat(project()?.id);
													props.terminals?.select(id);
												},
												onClose: (id) => props.terminals?.close(id),
											}
										: undefined
								}
								actions={
									<View class="flex-row">
										{() => {
											if (!hasProject()) return null;
											let lastProject = untracked(project)!;
											const currentProject = () => {
												const next = project();
												if (next) lastProject = next;
												return lastProject;
											};
											const terminals = props.terminals;
											return (
												<HeaderActions
													project={currentProject}
													onOpenTerminal={
														terminals
															? () => {
																	const current = project();
																	if (current) openTerminal(current.id);
																}
															: undefined
													}
													terminalRunning={() => {
														const current = project();
														return current
															? (terminals?.projectTabs(current.id) ?? []).some(
																	(tab) => !tab.exited,
																)
															: false;
													}}
													terminalOpening={() => terminals?.opening() ?? false}
													onNewTemporaryChat={() => {
														const current = project();
														if (current) newTemporaryChat(current.id);
													}}
													temporary={temporaryOpen}
													openInApp={props.openProjectInApp}
													onOpenGit={
														workspace && props.git
															? () => {
																	const current = project();
																	if (!current) return;
																	props.terminals?.select(null);
																	workspace.openGit(current.id);
																}
															: undefined
													}
													gitActive={() => shownGitProjectId() !== null}
													onError={(message) =>
														toasts.show({ variant: "error", title: message })
													}
												/>
											);
										}}
									</View>
								}
							/>
						) : null
					}
				</View>
				<View testID="workspace" class="relative min-h-0 min-w-0 flex-1">
					{() => {
						const current = status();
						switch (current.type) {
							case "starting":
								return <StartupLoading />;
							case "failed":
								return centered(
									<StartupFailure
										message={() => current.message}
										onRetry={() => store.retry()}
									/>,
								);
							case "closed":
								return centered(<RuntimeStopped />);
							case "ready":
								return sessionOpen() ? (
									<View class="min-h-0 min-w-0 flex-1 flex-col">
										<ChatMessageList
											assistantText={(text, textKey) => (
												<ChatMarkdown
													text={text}
													textKey={textKey}
													project={project}
													readProjectImage={props.readProjectImage}
													onFileLink={handleFileLink}
												/>
											)}
											preferences={() => store.state().preferences?.values}
											onForkAssistant={
												props.forker
													? (messageId) =>
															void props.forker?.forkAssistant(messageId)
													: undefined
											}
											// A temporary chat has no session file to fork; keep this reactive so
											// toggling temporary chat never remounts the message list or composer.
											canForkAssistant={() => !temporaryOpen()}
											forkingMessageId={() =>
												props.forker?.state().forkingMessageId ?? null
											}
											forkDisabled={() =>
												temporaryOpen() ||
												chat.state().status !== "ready" ||
												composer.readOnly() ||
												(props.forker?.state().forkingMessageId ?? null) !==
													null
											}
											transcript={chat.state}
											messages={() => chat.messages()}
											onRetry={() => chat.refresh()}
											onVisibleRangeChange={(start, end) =>
												chat.loadRange(start, end)
											}
											// Compaction shows under the last message, as React's viewport.
											footer={() => (
												<View>
													{() =>
														props.runConfig?.state()?.compacting ? (
															<ConversationColumn class="py-3">
																<ChatAgentActivityIndicator
																	testID="chat-compacting"
																	label={() => t("chat.compacting")}
																/>
															</ConversationColumn>
														) : null
													}
												</View>
											)}
											empty={() => (
												<SessionLanding
													store={store}
													project={project}
													onAddProject={() => openAddProject(null)}
												/>
											)}
										/>
										{/* The composer rises 16pt over the list, as the React page's
										    `-mt-4`: the messages end behind the card's rounded top. */}
										<View
											testID="chat-composer-region"
											class="relative z-20 -mt-4 w-full shrink-0 pb-4"
										>
											<ConversationColumn class="relative">
												<Each
													of={cacheNoticeSessions()}
													key={(sessionKey) => `cache-keep-alive:${sessionKey}`}
												>
													{(sessionKey) => (
														<CacheKeepAliveNotice
															status={() => cacheStatus(sessionKey())}
														/>
													)}
												</Each>

												{() => {
													const sessionKey = chatSessionKey();
													return sessionKey === null ? null : (
														<ChatTodoCapsule
															sessionKey={sessionKey}
															transcript={chat.state}
															running={() => composer.running()}
														/>
													);
												}}
												<ChatComposer
													store={composer}
													assistance={assistance}
													shortcuts={sessionShortcuts}
													appShortcuts={composerAppShortcuts}
													focusRequest={focusRequest}
													sendShortcut={() =>
														store.state().preferences?.values
															.sendMessageShortcut
													}
													runConfig={
														props.runConfig
															? {
																	config: () =>
																		props.runConfig?.state() ?? null,
																	models: () =>
																		props.catalog?.state()?.catalog?.models ??
																		[],
																	scopeModels: () =>
																		props.runConfig?.scopeModels ?? [],
																	scope: () =>
																		props.catalog?.state()?.scope ?? null,
																	scopeReady: () =>
																		props.runConfig?.catalogReady ?? false,
																	loading: () => {
																		const catalog = props.catalog?.state();
																		return (
																			!catalog?.loaded || catalog.refreshing
																		);
																	},
																	error: () =>
																		props.catalog?.state()?.error ?? null,
																	savingScope: () =>
																		props.catalog?.state()?.savingScope ??
																		false,
																	onModel: (model) =>
																		void props.runConfig?.setModel(model),
																	onThinking: (level) =>
																		void props.runConfig?.setThinkingLevel(
																			level,
																		),
																	onRefresh: props.catalog
																		? () => void props.catalog?.refresh()
																		: undefined,
																	onSaveScope: props.catalog
																		? (models) =>
																				props.catalog!.saveScope(models)
																		: undefined,
																}
															: undefined
													}
												/>
											</ConversationColumn>
										</View>
									</View>
								) : (
									centered(
										<SessionLanding
											store={store}
											project={project}
											onAddProject={() => openAddProject(null)}
										/>,
									)
								);
						}
					}}
					{workspace ? (
						<FilePreviewLayer
							workspace={workspace}
							active={shownFile}
							projectFor={(projectId) =>
								store.state().projects.find(({ id }) => id === projectId) ??
								null
							}
							preferences={() => store.state().preferences?.values}
							readProjectImage={props.readProjectImage}
							onFileLink={handleFileLink}
						/>
					) : null}
					{workspace && props.git ? (
						<GitWorkspaceLayer
							workspace={workspace}
							activeProjectId={shownGitProjectId}
							git={props.git}
							preferences={() => store.state().preferences?.values}
							canOpenFile={
								fileOpenContext
									? (path) => canOpenToolFilePath(fileOpenContext, path)
									: undefined
							}
							onOpenFile={
								fileOpenContext
									? (path) => openToolFilePath(fileOpenContext, path)
									: undefined
							}
						/>
					) : null}
					{props.terminals ? (
						<TerminalLayer
							terminals={props.terminals}
							shown={() => shownTerminal()?.id ?? null}
							preferences={() => store.state().preferences?.values}
						/>
					) : null}
				</View>
			</View>
		</View>
	);
	return (
		<AppToaster.Provider value={toasts}>
			<ChatMediaActions.Provider value={mediaActions}>
				<View
					testID="app"
					class="flex-1 flex-row bg-background text-(length:--pilo-ui-text-sm)"
				>
					<ConversationColumnLayout.Provider value={conversationLayout}>
						<ChatReadingFont.Provider value={readingFont}>
							{layout()}
						</ChatReadingFont.Provider>
					</ConversationColumnLayout.Provider>
					{() =>
						paletteOpen() ? (
							<CommandPalette
								store={store}
								searchSessions={props.searchSessions}
								shortcuts={registeredShortcuts}
								onOpenSettings={
									props.settings ? () => settingsOpen.set(true) : undefined
								}
								onClose={() => paletteOpen.set(false)}
							/>
						) : null
					}
					{() =>
						props.settings ? (
							<SettingsDialog
								open={settingsOpen}
								onClose={() => settingsOpen.set(false)}
								state={store.state}
								client={props.settings}
								desktop={props.desktop}
								notifications={props.notifications}
								update={update}
							/>
						) : null
					}
					{() =>
						update?.hasUpdate() ? <UpdateDialog update={update} /> : null
					}
					{() =>
						props.projectClient ? (
							<AddProjectDialog
								open={addProjectOpen}
								api={props.projectClient}
								connectionId={addProjectConnection}
								onAdd={(connectionId, path) =>
									store.addProject(connectionId, path)
								}
							/>
						) : null
					}
					{() =>
						client && remoteStatus && remoteOpen() ? (
							<RemoteDialog
								client={client}
								initialState={untracked(remoteStatus.state)}
								onClose={() => {
									remoteOpen.set(false);
									// The button follows a switch flipped in the dialog at once.
									void remoteStatus.refresh();
								}}
							/>
						) : null
					}
					<ChatImageLightbox
						image={previewImage}
						onClose={() => previewImage.set(null)}
						onSaveImage={props.saveImage}
					/>
					<AppToastStack toasts={toasts} />
				</View>
			</ChatMediaActions.Provider>
		</AppToaster.Provider>
	);
}

/** The first frame, before the Host theme is available to mount AppShell. */
export function StartupFrame(props: {
	/** The saved theme is Claude's, whose conversation column is wider. */
	claude?: boolean;
	/** The saved sidebar width; the default one without it. */
	sidebarWidth?: Accessor<number>;
}) {
	const window = currentWindow();
	window.set({ titleBar: { style: "hidden", height: TITLE_BAR_HEIGHT } });
	const titleBar = () => ({
		height: window.titleBar().height || TITLE_BAR_HEIGHT,
		left: window.titleBar().left,
	});
	const narrow = signal(false);
	const columnLayout = computed(() => ({
		claude: props.claude ?? false,
		narrow: narrow(),
	}));
	return (
		<View class="flex-1 flex-row bg-background">
			<StartupSidebar titleBar={titleBar} width={props.sidebarWidth} />
			<View
				class="min-w-0 flex-1"
				onLayout={({ bounds }) =>
					narrow.set(bounds.size.width < 40 * DEFAULT_CHAT_REM)
				}
			>
				<View
					desktop={{ windowDrag: true }}
					style={{ height: titleBar().height }}
				/>
				<View testID="workspace" class="min-h-0 flex-1">
					<ConversationColumnLayout.Provider value={columnLayout}>
						<StartupLoading />
					</ConversationColumnLayout.Provider>
				</View>
			</View>
		</View>
	);
}

/**
 * The workspace before the Host answers: the landing and composer the chat
 * page opens with, in their loading forms, as React's loading fallback.
 */
function StartupLoading() {
	return (
		<View
			testID="startup-loading"
			role="progressbar"
			accessible
			accessibilityLabel={t("common.loading")}
			class="min-h-0 min-w-0 flex-1"
		>
			<View class="min-h-0 flex-1 justify-center">
				<ConversationColumn>
					<SessionLanding loading />
				</ConversationColumn>
			</View>
			<View class="relative z-20 -mt-4 w-full shrink-0 pb-4">
				<ConversationColumn class="relative">
					<ChatComposerSkeleton showModel />
				</ConversationColumn>
			</View>
		</View>
	);
}

/** The runtime shut down under the app; only a new launch starts another. */
function RuntimeStopped() {
	return (
		<ErrorState
			testID="runtime-stopped"
			title={() => t("app.runtimeStopped")}
			description={() => t("app.runtimeStoppedDescription")}
		/>
	);
}

/** Startup did not finish; with `onRetry` the user can run it again. */
function StartupFailure(props: {
	message: () => string;
	onRetry: () => Promise<void>;
}) {
	return (
		<ErrorState
			testID="startup-failed"
			title={() => t("common.loadFailed")}
			description={props.message}
			onRetry={props.onRetry}
			retryLabel={() => t("common.retry")}
			retryTestID="startup-retry"
		/>
	);
}
