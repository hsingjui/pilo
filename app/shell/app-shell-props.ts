import type { HostClient } from "@shared/api/host-client";
import type { ChatMarkdownFileLink } from "../chat/chat-markdown";
import type { ComposerAssistanceClient } from "../composer/composer-assistance";
import type { ComposerStore } from "../composer/composer-store";
import type {
	SettingsClient,
	SettingsDialogProps,
	SettingsTabId,
} from "../settings/settings-dialog";
import type { AddProjectApi } from "./add-project-dialog";
import type { AppStore } from "../state/app-store";
import type { ChatQueueStore } from "../state/chat-queue-store";
import type { ChatRunConfigStore } from "../state/chat-run-config";
import type { ChatTranscriptStore } from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";
import type { TerminalStore } from "../state/terminal-store";
import type { WorkspaceStore } from "../state/workspace-store";
import type { SessionForker } from "./session-fork";
import type { AppToasts } from "./app-toasts";
import type {
	DesktopShell,
	DesktopWindowShell,
	ProjectNativeApp,
} from "./desktop-shell";
import type { DesktopUpdate } from "./desktop-update";
import type { GitWorkspaceClient } from "./git-workspace-view";
import type { FileLinkOpenContext } from "./open-file-link";
import type { SidebarSettingsStore } from "./sidebar-settings";

export interface AppShellProps {
	/** The app state the shell shows; whoever mounts the shell starts it. */
	store: AppStore;
	/** The open session's transcript; whoever mounts the shell keeps it open. */
	chat: Pick<
		ChatTranscriptStore,
		"state" | "messages" | "refresh" | "loadRange"
	> &
		Partial<
			Pick<
				ChatTranscriptStore,
				"messageCount" | "isPlaceholderFailed" | "retryPlaceholder"
			>
		>;
	/** The open session's composer; whoever mounts the shell targets it. */
	composer: ComposerStore;
	/** Pending steer/follow-up messages queued during active turns. */
	queue?: ChatQueueStore;
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
	previewFileLink?: FileLinkOpenContext["previewFileLink"];
	openFileLink?: FileLinkOpenContext["openFileLink"];
	/** Native Git status/diff reader for the desktop-only Git workspace tab. */
	git?: GitWorkspaceClient;
	/** Per-project open file preview and Git tabs. */
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
	) => Promise<void> | void;
	/** Pauses prompt-cache keep-alive for one session without changing settings. */
	onPauseCacheKeepAlive?: (sessionKey: string) => Promise<void> | void;
	/** Forks the open session at an assistant message. */
	forker?: Pick<SessionForker, "state" | "forkAssistant" | "dismissNotice">;
	/** Searches saved message text for the command palette. */
	searchSessions?: Pick<HostClient, "searchSessions">;
	/** The settings panes' saves and reads; no settings entry without it. */
	settings?: SettingsClient;
	/** The client calls the add-project dialog needs; `undefined` hides it. */
	projectClient?: AddProjectApi;
	/** `false` hides removing projects (a Host paired without workspace access). */
	canRemoveProjects?: boolean;
	desktop?: DesktopWindowShell;
	shell?: Pick<
		DesktopShell,
		| "pickLocalProjectDirectory"
		| "systemFontFamilies"
		| "openLogDirectory"
		| "openExternal"
		| "notifications"
		| "createUpdate"
		| "cli"
	>;
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
	/** Whether this client manages the Host's remote access (only on its own machine). */
	remoteAccess?: boolean;
	/** The Host's connections are listed but edited only on that Host. */
	connectionsReadOnly?: boolean;
	/** Paired desktop Hosts and the local pairing flow. */
	remoteHostPairing?: SettingsDialogProps["remoteHostPairing"];
	/** Settings panes the Host does not let this client use. */
	hiddenSettingsTabs?: readonly SettingsTabId[];
	/** Add Project browses the Host's folders instead of this machine's picker. */
	browseHostDirectories?: boolean;
}
