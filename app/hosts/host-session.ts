import { effect } from "nsh";

import type { HostClient } from "@shared/api/host-client";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { RemoteScopes } from "@shared/api/remote-types";
import { LOCAL_HOST_ID } from "@shared/host-id";
import { hasRemoteScope } from "@shared/remote-hosts";
import type { ComposerStore } from "../composer/composer-store";
import { isSessionUnread } from "../state/app-state";
import { AppStore } from "../state/app-store";
import { ChatQueueStore } from "../state/chat-queue-store";
import { createWorkspaceComposer } from "../state/chat-workspace";
import { ChatRunConfigStore } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { ModelCatalogStore } from "../state/model-catalog";
import { TerminalStore } from "../state/terminal-store";
import { WorkspaceStore } from "../state/workspace-store";
import type { AppShellProps } from "../shell/app-shell-props";
import { AppToasts } from "../shell/app-toasts";
import type { DesktopNotificationsApi } from "../shell/desktop-notifications";
import type { DesktopShell, DesktopWindowShell } from "../shell/desktop-shell";
import { t } from "../shell/i18n";
import {
	conversationContext,
	endLeftTemporaryChats,
	followOpenSession,
	followRunConfig,
	openChatTarget,
} from "../shell/open-chat";
import { followOpenSessionRead } from "../shell/read-open-session";
import { SessionForker } from "../shell/session-fork";
import {
	connectSessionNotifications,
	type SessionNotifier,
} from "../shell/session-notifications";
import { SidebarSettingsStore } from "../shell/sidebar-settings";

/** What a Host lets this window do: everything locally, its paired scopes remotely. */
export type HostAccess = {
	scopes: RemoteScopes | null;
	/** The Host API methods the Host offers; `null` when it did not say. */
	methods: readonly string[] | null;
};

export const LOCAL_HOST_ACCESS: HostAccess = { scopes: null, methods: null };

/** Equal access keeps the shell mounted: a reconnect's hello with the same scopes and methods. */
export function sameHostAccess(previous: HostAccess, next: HostAccess) {
	return (
		previous.scopes === next.scopes &&
		(previous.methods === null) === (next.methods === null) &&
		(previous.methods ?? []).join("\n") === (next.methods ?? []).join("\n")
	);
}

export type HostSessionOptions = {
	hostId: string;
	kind: "local" | "remote";
	client: HostClient;
	shell: DesktopShell;
	/** Called with every live event of the Host (after notifications see it). */
	onLiveEvent?: (event: PiloClientEvent) => void;
};

/**
 * One Host's stores: its app state, open transcript, composer, terminals and
 * event subscription. Sessions of different Hosts never share a store, and
 * disposing a remote session only closes this window's connection.
 */
export class HostSession {
	readonly hostId: string;
	readonly kind: "local" | "remote";
	readonly client: HostClient;
	readonly store: AppStore;
	readonly chat: ChatTranscriptStore;
	readonly workspace = new WorkspaceStore();
	readonly terminals: TerminalStore;
	readonly catalog: ModelCatalogStore;
	readonly runConfig: ChatRunConfigStore;
	readonly queue: ChatQueueStore;
	readonly composer: ComposerStore;
	readonly forker: SessionForker;
	readonly toasts = new AppToasts();
	readonly sidebarSettings: SidebarSettingsStore;
	private notify: SessionNotifier | undefined;
	private disposed = false;

	constructor(private readonly options: HostSessionOptions) {
		const { hostId, kind, client, shell } = options;
		this.hostId = hostId;
		this.kind = kind;
		this.client = client;
		this.chat = new ChatTranscriptStore(client, conversationContext());
		this.terminals = new TerminalStore(client);
		const workspace = this.workspace;
		const terminals = this.terminals;
		this.store = new AppStore(
			client,
			this.chat,
			(event) => {
				options.onLiveEvent?.(event);
				void this.notify?.(event).catch((error: unknown) => {
					console.warn("Failed to send Pilo session notification", error);
				});
			},
			(projectId) =>
				terminals.activeTab(projectId) === null &&
				!workspace.isGitActive(projectId) &&
				workspace.activeFile(projectId) === null,
		);
		const store = this.store;
		this.catalog = new ModelCatalogStore(client);
		this.runConfig = new ChatRunConfigStore(client, this.catalog.state);
		this.queue = new ChatQueueStore(client);
		const queue = this.queue;
		store.subscribeEventMessages((message) => {
			if (!message || message.type === "resyncRequired") {
				queue.reset();
				return;
			}
			if (message.type !== "events") return;
			for (const event of message.events) queue.receive(event);
		});
		this.composer = createWorkspaceComposer({
			client,
			hostId,
			shell,
			store,
			chat: this.chat,
			catalog: this.catalog,
			runConfig: this.runConfig,
			queue,
			toasts: this.toasts,
			onNewChat: (projectId) => {
				terminals.select(null);
				workspace.selectChat(projectId);
			},
		});
		const chat = this.chat;
		this.forker = new SessionForker(client, {
			target: () => openChatTarget(store.state()),
			messages: () => chat.messages(),
			disabled: () => {
				const target = openChatTarget(store.state());
				const held = store
					.state()
					.chatSessions.find((c) => c.sessionKey === target?.sessionKey);
				return chat.state().status !== "ready" || (held?.activeTurn ?? false);
			},
			onForked: (projectId, sessionPath) => {
				void store
					.loadSessions(projectId)
					.then(() => store.selectSession(projectId, sessionPath));
			},
		});
		this.sidebarSettings = new SidebarSettingsStore(hostId);
	}

	/**
	 * Keeps the session's chat, run config, read marks and notifications in
	 * step with its state. Call inside the component that owns the session,
	 * so the effects end with it.
	 */
	follow(context: {
		desktop?: Pick<DesktopWindowShell, "show" | "isQuitting">;
		notifications?: DesktopNotificationsApi;
		/** Brings this Host's session to the front, before a notification opens its chat. */
		onActivate?: () => void;
		isActive: () => boolean;
	}) {
		const { store, chat, client, toasts } = this;
		store.isShown = context.isActive;
		this.composer.followBackgroundSessions();
		followOpenSession(store, chat);
		endLeftTemporaryChats(
			store,
			chat,
			(sessionKey, reason) => client.stopChat(sessionKey, reason),
			{
				onLeaving: ({ graceMs, restore, onDismiss }) => {
					const toastId = toasts.show({
						variant: "info",
						title: t("app.temporaryChatLeaving"),
						countdown: (count) => t("app.temporaryChatClearingIn", { count }),
						timeout: graceMs,
						onDismiss,
						action: {
							label: t("app.returnToTemporaryChat"),
							onPress: restore,
						},
					});
					return () => {
						if (toastId) toasts.dismiss(toastId);
					};
				},
			},
		);
		followOpenSessionRead(store);
		followRunConfig(store, this.runConfig, this.catalog, chat);
		if (context.desktop && context.notifications) {
			this.notify = connectSessionNotifications(
				client,
				store,
				context.desktop,
				context.notifications,
				{
					hostId: this.hostId,
					isViewingSession: (projectId, sessionPath) =>
						context.isActive() &&
						store.isViewingSession(projectId, sessionPath),
					onActivate: context.onActivate,
					onSelectTarget: (projectId) => {
						this.terminals.select(null);
						this.workspace.selectChat(projectId);
					},
				},
			);
		}
		effect(() => () => {
			this.notify?.dispose();
			this.notify = undefined;
		});
	}

	/** Finished turns not yet seen, for the Dock badge. */
	unreadCount(): number {
		const state = this.store.state();
		let count = 0;
		for (const key of Object.keys(state.readStates)) {
			const [projectId, sessionPath] = key.split("\n");
			if (
				projectId &&
				sessionPath &&
				isSessionUnread(state, projectId, sessionPath)
			)
				count += 1;
		}
		return count;
	}

	/** The shell's props for this Host, with the entries its access allows. */
	shellProps(
		access: HostAccess,
		shell: DesktopShell,
	): Omit<AppShellProps, "desktop" | "remoteHostPairing"> {
		const { client, store } = this;
		const local = this.kind === "local";
		const offers = (method: string) =>
			access.methods === null || access.methods.includes(method);
		const workspaceScope = local || hasRemoteScope(access.scopes, "workspace");
		const preview = workspaceScope && offers("project.file.preview");
		return {
			store,
			chat: this.chat,
			composer: this.composer,
			queue: this.queue,
			assistanceClient: client,
			runConfig: this.runConfig,
			catalog: this.catalog,
			forker: this.forker,
			searchSessions: client,
			settings: client,
			projectClient:
				workspaceScope && offers("project.add") ? client : undefined,
			canRemoveProjects: workspaceScope && offers("project.remove"),
			shell: local ? shell : { ...shell, pickLocalProjectDirectory: undefined },
			sidebarSettings: this.sidebarSettings,
			toasts: this.toasts,
			workspace: this.workspace,
			terminals:
				workspaceScope && offers("terminal.open") ? this.terminals : undefined,
			// A remote Host's paths mean nothing to this machine's apps.
			openProjectInApp: local ? shell.openProjectInApp : undefined,
			previewFileLink: preview
				? (projectId, url) => client.previewFileLink(projectId, url)
				: undefined,
			openFileLink: local ? shell.openFileLink : undefined,
			git: workspaceScope && offers("git.status") ? client : undefined,
			onRenameSession: (projectId, sessionPath, title) =>
				store.renameSession(projectId, sessionPath, title),
			onPauseCacheKeepAlive: (sessionKey) =>
				client.pauseCacheKeepAlive(sessionKey),
			readProjectImage: (projectId, path) =>
				client.readProjectImage(projectId, path),
			readHistoryImage: (projectId, sessionPath, imageId) =>
				client.readHistoryImage(projectId, sessionPath, imageId),
			saveImage: shell.saveImage,
			remoteAccess: local,
			connectionsReadOnly: !local,
			hiddenSettingsTabs: local ? undefined : ["session-naming"],
			browseHostDirectories: !local,
		};
	}

	start(): Promise<void> {
		return this.store.start();
	}

	/** Closes this window's connection to a remote Host; the Host keeps running. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.notify?.dispose();
		this.notify = undefined;
		this.store.isShown = () => false;
		this.store.stop();
		this.terminals.dispose();
		this.client.dispose();
	}

	/** Quits the embedded Host with the app. */
	async shutdown(): Promise<void> {
		if (this.hostId !== LOCAL_HOST_ID) {
			this.dispose();
			return;
		}
		this.disposed = true;
		this.store.stop();
		await this.client.shutdown();
	}
}
