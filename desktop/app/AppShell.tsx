import {
	type Accessor,
	computed,
	effect,
	type JSX,
	Overlay,
	signal,
	Text,
	View,
} from "nsh";
import { currentWindow, titleBar } from "nsh/desktop";

import type { Project } from "@/lib/api/projects-types";
import { ChatMessageList } from "../chat/chat-message-list";
import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import { ChatComposer } from "../composer/chat-composer";
import type { ComposerStore } from "../composer/composer-store";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type { ChatRunConfigStore } from "../state/chat-run-config";
import type { ChatTranscriptStore } from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Toast } from "../ui/toast";
import { followSavedAppearance } from "./appearance";
import { t } from "./i18n";
import { openChatTarget } from "./open-chat";
import { SessionHeader } from "./session-header";
import type { SessionForker } from "./session-fork";
import { Sidebar } from "./Sidebar";
import { SidebarSettingsStore } from "./sidebar-settings";

/** The sidebar's width until the user resizes it, as in the Tauri app. */
const SIDEBAR_WIDTH = 292;
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
	/** The title the header shows: Pi's name wins over the index entry's. */
	const openSessionTitle = () =>
		props.runConfig?.state()?.session?.name ??
		openSessionEntry()?.titleOverride ??
		openSessionEntry()?.name ??
		openSessionEntry()?.firstUserMessagePreview ??
		t("app.newChat");
	const collapsed = signal(false);
	const sidebarSettings = new SidebarSettingsStore();
	void sidebarSettings.load();
	effect(() => composer.setTarget(openChatTarget(store.state())));
	followSavedAppearance(store.state);
	// The app draws its own title bar: the sidebar and the main area reach
	// the window's top edge, beside the system's window controls.
	currentWindow().set({
		titleBar: { style: "hidden", height: TITLE_BAR_HEIGHT },
	});
	const barHeight = () => titleBar().height || TITLE_BAR_HEIGHT;
	const toggle = (testID: string, label: () => string) => (
		<Button
			testID={testID}
			variant="ghost"
			size="icon"
			accessibilityLabel={label()}
			onPress={() => collapsed.update((value) => !value)}
		>
			<Icon name="PanelLeft" />
		</Button>
	);
	/** A page of the workspace that is not a chat, in its middle. */
	const centered = (page: JSX.Element) => (
		<View class="flex-1 items-center justify-center gap-2 p-6">{page}</View>
	);
	return (
		<View testID="app" class="flex-1 flex-row bg-background">
			{() =>
				collapsed() ? null : (
					<View
						testID="sidebar"
						class="shrink-0 border-r border-sidebar-border bg-sidebar-background"
						style={{ width: SIDEBAR_WIDTH }}
					>
						<View
							testID="sidebar-title-bar"
							desktop={{ windowDrag: true }}
							class="flex-row items-center justify-end px-2"
							style={{ height: barHeight(), paddingLeft: titleBar().left }}
						>
							{toggle("sidebar-collapse", () => t("sidebar.collapseSidebar"))}
						</View>
						{() =>
							status().type === "ready" && sidebarSettings.loaded() ? (
								<Sidebar store={store} settings={sidebarSettings} />
							) : null
						}
					</View>
				)
			}
			<View testID="main" class="min-w-0 flex-1">
				<View
					testID="main-title-bar"
					desktop={{ windowDrag: true }}
					class="flex-row items-center px-2"
					style={{
						height: barHeight(),
						paddingLeft: collapsed() ? titleBar().left + 8 : 8,
					}}
				>
					{() =>
						collapsed()
							? toggle("sidebar-expand", () => t("sidebar.expandSidebar"))
							: null
					}
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
															if (session)
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
											empty={() => <NewSession project={project} />}
										/>
										<ChatComposer
											store={composer}
											sendShortcut={() =>
												store.state().preferences?.values.sendMessageShortcut
											}
										/>
									</View>
								) : (
									centered(<ProjectPlaceholder project={project} />)
								);
						}
					}}
				</View>
			</View>
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

/** What a session without messages shows, until the new session view. */
function NewSession(props: { project: Accessor<Project | null> }) {
	return (
		<View class="max-w-full items-center gap-2">
			<Text
				testID="new-session-title"
				class="text-center font-sans text-xl font-semibold text-foreground"
			>
				{() => t("app.newChat")}
			</Text>
			<Text
				testID="new-session-project"
				class="text-center font-sans text-sm text-muted-foreground"
			>
				{() => props.project()?.name ?? ""}
			</Text>
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

/** Stands where the chat of the chosen project will be. */
function ProjectPlaceholder(props: { project: Accessor<Project | null> }) {
	return (
		<View class="max-w-full items-center gap-2">
			<Text
				testID="workspace-title"
				class="text-center font-sans text-xl font-semibold text-foreground"
			>
				{() => props.project()?.name ?? t("app.addProjectFirst")}
			</Text>
			<Text
				testID="workspace-path"
				class="text-center font-mono text-xs text-muted-foreground"
			>
				{() => props.project()?.path ?? ""}
			</Text>
		</View>
	);
}
