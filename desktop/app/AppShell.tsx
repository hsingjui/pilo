import {
	computed,
	effect,
	type JSX,
	keymap,
	signal,
	token,
	untracked,
	View,
} from "nsh";
import { currentWindow } from "nsh/desktop";

import type { Project } from "@/lib/api/projects-types";
import { ChatAgentActivityIndicator } from "../chat/chat-agent-activity";
import { ChatMessageList } from "../chat/chat-message-list";
import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import { ChatTodoCapsule } from "../chat/chat-todo-capsule";
import {
	ConversationColumn,
	ConversationColumnLayout,
} from "../chat/conversation-column";
import { DEFAULT_CHAT_REM } from "../chat/layout";
import { ChatComposer, ChatComposerSkeleton } from "../composer/chat-composer";
import type { ComposerStore } from "../composer/composer-store";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type { ChatRunConfigStore } from "../state/chat-run-config";
import type { ChatTranscriptStore } from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { APP_SHORTCUTS } from "../shortcuts";
import {
	SettingsDialog,
	type SettingsClient,
} from "../settings/settings-dialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ErrorState } from "../ui/state-view";
import { AppToaster, AppToasts, AppToastStack } from "./app-toasts";
import { followSavedAppearance } from "./appearance";
import { CommandPalette } from "./command-palette";
import type { DesktopShell } from "./desktop-shell";
import { t } from "./i18n";
import { AddProjectDialog, type AddProjectApi } from "./add-project-dialog";
import { SessionLanding } from "./landing";
import { openChatTarget } from "./open-chat";
import { SessionHeader } from "./session-header";
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
	/** Reads a project-relative image's bytes (reply `![…](path)` previews). */
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	/** What a project file link in a reply does when pressed (a workspace tab, M5). */
	onFileLink?: (link: ChatMarkdownFileLink) => void;
	/** The open session's run configuration; a header shows it when present. */
	runConfig?: Pick<
		ChatRunConfigStore,
		"state" | "setModel" | "setThinkingLevel" | "scopeModels" | "catalogReady"
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
}

export function AppShell(props: AppShellProps) {
	const { store, chat, composer } = props;
	const status = computed(() => store.state().status);
	const project = computed(() => activeProject(store.state()));
	const sessionOpen = computed(() => store.state().navigation.session !== null);
	/** The open session's index entry, for its title and Pi session id. */
	const openSessionEntry = () => {
		const open = store.state().navigation.session;
		if (!open) return null;
		return (
			store
				.state()
				.sessionIndexes[open.projectId]?.sessions.find(
					(entry) => entry.sessionPath === open.sessionPath,
				) ?? null
		);
	};
	/** An explicit rename wins; otherwise prefer Pi's current name. */
	const openSessionTitle = () =>
		openSessionEntry()?.titleOverride ??
		props.runConfig?.state()?.session?.name ??
		openSessionEntry()?.name ??
		openSessionEntry()?.firstUserMessagePreview ??
		t("app.newChat");
	const paletteOpen = signal(false);
	const settingsOpen = signal(false);
	const addProjectOpen = signal(false);
	const addProjectConnection = signal<string | null>(null);
	const sidebarSettings = new SidebarSettingsStore();
	void sidebarSettings.load();
	const sidebarLayout = createSidebarLayout(sidebarSettings);
	const collapsed = sidebarLayout.collapsed;
	// The expand button fades in once the sidebar has collapsed, and out as
	// it opens, as the Tauri header's button does.
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
	const chatTarget = computed(() => openChatTarget(store.state()));
	const chatSessionKey = computed(() => chatTarget()?.sessionKey ?? null);
	effect(() => composer.setTarget(chatTarget()));
	// Without an open session the workspace holds a new chat in the active
	// project, as the Tauri landing does, so its composer is always there.
	effect(() => {
		const state = store.state();
		if (state.status.type !== "ready" || state.navigation.session) return;
		const project = activeProject(state);
		if (project) untracked(() => store.selectProject(project.id));
	});
	/** A new chat with nothing sent yet: the landing, without a session header. */
	const draftLanding = () =>
		store.state().navigation.session?.sessionId !== undefined &&
		chat.messages().length === 0;
	followSavedAppearance(store.state);
	const toasts = new AppToasts();
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
	keymap.bind({
		[APP_SHORTCUTS.openCommandPalette]: () =>
			paletteOpen.update((open) => !open),
		[APP_SHORTCUTS.newChat]: () => {
			const project = activeProject(store.state());
			if (project) store.selectProject(project.id);
		},
		[APP_SHORTCUTS.openSettings]: () => {
			if (props.settings) settingsOpen.set(true);
		},
	});
	// The app draws its own title bar: the sidebar and the main area reach
	// the window's top edge, beside the system's window controls.
	const window = currentWindow();
	window.set({ titleBar: { style: "hidden", height: TITLE_BAR_HEIGHT } });
	const titleBar = () => window.titleBar();
	const barHeight = () => titleBar().height || TITLE_BAR_HEIGHT;
	const newChat = () => {
		const project = activeProject(store.state());
		if (project) store.selectProject(project.id);
		else if (props.projectClient) openAddProject(null);
	};
	const openAddProject = (connectionId: string | null) => {
		addProjectConnection.set(connectionId);
		addProjectOpen.set(true);
	};
	const client = props.settings;
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
				onOpenSettings={client ? () => settingsOpen.set(true) : undefined}
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
						status().type === "ready" && sessionOpen() && !draftLanding() ? (
							<SessionHeader
								logoHidden={collapsed}
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
							/>
						) : null
					}
				</View>
				<View testID="workspace" class="min-h-0 min-w-0 flex-1">
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
											assistantText={(text) => (
												<ChatMarkdown
													text={text}
													project={project}
													readProjectImage={props.readProjectImage}
													onFileLink={props.onFileLink}
												/>
											)}
											preferences={() => store.state().preferences?.values}
											onForkAssistant={
												props.forker
													? (messageId) =>
															void props.forker?.forkAssistant(messageId)
													: undefined
											}
											forkingMessageId={() =>
												props.forker?.state().forkingMessageId ?? null
											}
											forkDisabled={() =>
												chat.state().status !== "ready" ||
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
													sendShortcut={() =>
														store.state().preferences?.values
															.sendMessageShortcut
													}
													readingFontSize={() =>
														store.state().preferences?.values.readingFontSize
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
				</View>
			</View>
		</View>
	);
	return (
		<AppToaster.Provider value={toasts}>
			<View testID="app" class="flex-1 flex-row bg-background">
				<ConversationColumnLayout.Provider value={conversationLayout}>
					{layout()}
				</ConversationColumnLayout.Provider>
				{() =>
					paletteOpen() ? (
						<CommandPalette
							store={store}
							searchSessions={props.searchSessions}
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
						/>
					) : null
				}
				{() =>
					props.projectClient ? (
						<AddProjectDialog
							open={addProjectOpen}
							api={props.projectClient}
							initialConnectionId={addProjectConnection}
							onAdd={(connectionId, path) =>
								store.addProject(connectionId, path)
							}
						/>
					) : null
				}
				<AppToastStack toasts={toasts} />
			</View>
		</AppToaster.Provider>
	);
}

/** The first frame, before the Host theme is available to mount AppShell. */
export function StartupFrame() {
	const window = currentWindow();
	window.set({ titleBar: { style: "hidden", height: TITLE_BAR_HEIGHT } });
	const titleBar = () => ({
		height: window.titleBar().height || TITLE_BAR_HEIGHT,
		left: window.titleBar().left,
	});
	return (
		<View class="flex-1 flex-row bg-background">
			<StartupSidebar titleBar={titleBar} />
			<View class="min-w-0 flex-1">
				<View
					desktop={{ windowDrag: true }}
					style={{ height: titleBar().height }}
				/>
				<View testID="workspace" class="min-h-0 flex-1">
					<StartupLoading />
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
		<View testID="startup-loading" class="min-h-0 min-w-0 flex-1">
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
