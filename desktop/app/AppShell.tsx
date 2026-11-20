import {
	computed,
	effect,
	type JSX,
	keymap,
	Overlay,
	signal,
	Text,
	token,
	View,
} from "nsh";
import { currentWindow } from "nsh/desktop";

import type { Project } from "@/lib/api/projects-types";
import { ChatMessageList } from "../chat/chat-message-list";
import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import { ChatTodoCapsule } from "../chat/chat-todo-capsule";
import { ChatComposer } from "../composer/chat-composer";
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
import { Toast } from "../ui/toast";
import { followSavedAppearance } from "./appearance";
import { CommandPalette } from "./command-palette";
import type { DesktopShell } from "./desktop-shell";
import { t } from "./i18n";
import { AddProjectDialog, type AddProjectApi } from "./add-project-dialog";
import { SessionLanding } from "./landing";
import { openChatTarget } from "./open-chat";
import { SessionHeader } from "./session-header";
import type { SessionForker } from "./session-fork";
import { createSidebarLayout } from "./sidebar-layout";
import { SidebarPanel } from "./sidebar-panel";
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
		"state" | "setModel" | "setThinkingLevel" | "scopeModels"
	>;
	/** The active project's model catalog, for the header's picker. */
	catalog?: Pick<ModelCatalogStore, "state" | "refresh">;
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
	const chatTarget = computed(() => openChatTarget(store.state()));
	const chatSessionKey = computed(() => chatTarget()?.sessionKey ?? null);
	effect(() => composer.setTarget(chatTarget()));
	followSavedAppearance(store.state);
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
	return (
		<View testID="app" class="flex-1 flex-row bg-background">
			<SidebarPanel
				store={store}
				settings={sidebarSettings}
				layout={sidebarLayout}
				ready={() => status().type === "ready" && sidebarSettings.loaded()}
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
			<View testID="main" class="min-w-0 flex-1">
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
				</View>
				<View testID="workspace" class="min-h-0 min-w-0 flex-1">
					{() => {
						const current = status();
						switch (current.type) {
							case "starting":
								return centered(<StartupLoading />);
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
										<SessionHeader
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
											compacting={() =>
												props.runConfig?.state()?.compacting ?? false
											}
											usage={() => props.runConfig?.state()?.session ?? null}
											runConfig={() => props.runConfig?.state() ?? null}
											models={() =>
												props.runConfig &&
												props.runConfig.scopeModels.length > 0
													? props.runConfig.scopeModels
													: (props.catalog?.state()?.catalog?.models ?? [])
											}
											modelsLoading={() => {
												const catalog = props.catalog?.state();
												return !catalog?.loaded || catalog.refreshing;
											}}
											onModel={(model) => void props.runConfig?.setModel(model)}
											onThinking={(level) =>
												void props.runConfig?.setThinkingLevel(level)
											}
											onRefreshModels={
												props.catalog
													? () => void props.catalog?.refresh()
													: undefined
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
											empty={() => (
												<SessionLanding
													store={store}
													project={project}
													onAddProject={() => openAddProject(null)}
												/>
											)}
										/>
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
												store.state().preferences?.values.sendMessageShortcut
											}
										/>
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
						onAdd={(connectionId, path) => store.addProject(connectionId, path)}
					/>
				) : null
			}
			{() => {
				const notice = props.forker?.state().notice;
				return notice ? (
					<Overlay class="top-14 right-4 w-96">
						<Toast
							testID={`fork-notice-${notice.id}`}
							transitionStatus="present"
							variant={notice.kind}
							description={notice.description}
							accessibilityLabel={notice.title}
							closeLabel={t("common.close")}
							onDismissRequest={() => props.forker?.dismissNotice()}
						>
							<Text>{notice.title}</Text>
						</Toast>
					</Overlay>
				) : null;
			}}
		</View>
	);
}

function StartupLoading() {
	return (
		<Text
			testID="startup-loading"
			class="font-sans text-sm text-muted-foreground"
		>
			{() => t("common.loading")}
		</Text>
	);
}

/** Startup did not finish; with `onRetry` the user can run it again. */
/** The runtime shut down under the app; only a new launch starts another. */
function RuntimeStopped() {
	return (
		<View
			testID="runtime-stopped"
			role="alert"
			class="max-w-md items-center gap-4"
		>
			<Text class="text-center font-sans text-lg font-medium text-foreground">
				{() => t("app.runtimeStopped")}
			</Text>
			<Text class="text-center font-sans text-sm text-muted-foreground">
				{() => t("app.runtimeStoppedDescription")}
			</Text>
		</View>
	);
}

function StartupFailure(props: {
	message: () => string;
	onRetry: () => Promise<void>;
}) {
	const retrying = signal(false);
	return (
		<View
			testID="startup-failed"
			role="alert"
			class="max-w-md items-center gap-4"
		>
			<Text class="text-center font-sans text-lg font-medium text-foreground">
				{() => t("common.loadFailed")}
			</Text>
			<Text
				testID="startup-failed-message"
				class="text-center font-sans text-sm text-muted-foreground"
			>
				{props.message}
			</Text>
			<Button
				testID="startup-retry"
				variant="outline"
				disabled={retrying()}
				onPress={() => {
					retrying.set(true);
					void props.onRetry().finally(() => retrying.set(false));
				}}
			>
				<Text>{() => t("common.retry")}</Text>
			</Button>
		</View>
	);
}
