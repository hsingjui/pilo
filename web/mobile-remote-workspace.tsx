import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";

import { HostClient } from "@shared/api/host-client";
import type { HostApiMethodName } from "@shared/api/host-methods";
import type { HostHelloMessage } from "@shared/api/host-transport";
import { userErrorMessage } from "@shared/app-error";
import { AppToasts, showToast } from "../app/shell/app-toasts";
import { t } from "../app/shell/i18n";
import {
	conversationContext,
	endLeftTemporaryChats,
	followOpenSession,
	followRunConfig,
	openChatTarget,
} from "../app/shell/open-chat";
import { followOpenSessionRead } from "../app/shell/read-open-session";
import { SessionForker } from "../app/shell/session-fork";
import { AppStore } from "../app/state/app-store";
import { ChatRunConfigStore } from "../app/state/chat-run-config";
import { ChatTranscriptStore } from "../app/state/chat-transcript-store";
import { createWorkspaceComposer } from "../app/state/chat-workspace";
import { ModelCatalogStore } from "../app/state/model-catalog";
import { MobileAppShell } from "./mobile-app-shell";
import { RemoteChatQueue } from "./remote-chat-queue";
import { RemoteExtensionUi } from "./remote-extension-ui";
import { webDesktopShell } from "./web-desktop-shell";
import { browserSessionStorage } from "./web-remote-browser";
import {
	canUseWebWorkspace,
	createWebHostTransport,
	type WebRemoteConnectionState,
	type WebRemoteRecoveryState,
} from "./web-host-transport";
import { createWebWorkspaceStorage } from "./web-workspace-storage";
import { Button } from "../app/ui/button";

export interface MobileRemoteWorkspaceProps {
	token: string;
	onAuthExpired: () => void;
	onSignOut?: () => void;
}

export function MobileRemoteWorkspace(props: MobileRemoteWorkspaceProps) {
	const transport = createWebHostTransport(props.token, props.onAuthExpired);
	const client = new HostClient(transport);
	const stream = client.eventStream();
	const hello = signal<HostHelloMessage | null>(null);
	const connectionState = signal<WebRemoteConnectionState>(
		transport.currentState,
	);
	const recoveryState = signal<WebRemoteRecoveryState>("idle");
	let connected = false;
	let recoveredTimer: ReturnType<typeof setTimeout> | undefined;
	const disconnectState = stream.onConnectionState?.((state) => {
		connectionState.set(state);
		clearTimeout(recoveredTimer);
		if (state === "connected") {
			recoveryState.set(connected ? "recovered" : "idle");
			if (connected) {
				recoveredTimer = setTimeout(() => recoveryState.set("idle"), 2_500);
			}
			connected = true;
		} else if (connected) {
			recoveryState.set("reconnecting");
		}
	});
	const disconnectHello = stream.onHello?.((message) => hello.set(message));
	const disconnect = stream.subscribeEvents({
		onStatus: () => {},
		onMessage: () => {},
	});
	const hostId = computed(() => hello()?.hostId ?? null);
	cleanup(() => {
		clearTimeout(recoveredTimer);
		disconnectHello?.();
		disconnectState?.();
		disconnect();
		client.dispose();
	});
	const reconnect = () => transport.reconnectNow();
	return (
		<View class="min-h-0 flex-1">
			{() => {
				const id = hostId();
				return id ? (
					<ConnectedWorkspace
						client={client}
						hostId={id}
						connectionState={connectionState}
						recoveryState={recoveryState}
						canUseWorkspace={(...methods) =>
							canUseWebWorkspace(hello()?.scopes, client, ...methods)
						}
						onReconnect={reconnect}
						onSignOut={props.onSignOut}
					/>
				) : (
					<View class="flex-1 items-center justify-center gap-3 p-6">
						<Text class="text-center font-sans text-foreground">
							{() =>
								t(
									connectionState() === "incompatible"
										? "settings.remoteProtocolIncompatible"
										: connectionState() === "offline"
											? "settings.remoteOffline"
											: "settings.remoteReconnecting",
								)
							}
						</Text>
						{() =>
							connectionState() === "incompatible" ? null : (
								<Button class="min-h-11" onPress={reconnect}>
									<Text>{() => t("common.retry")}</Text>
								</Button>
							)
						}
						<Button class="min-h-11" variant="ghost" onPress={props.onSignOut}>
							<Text>{() => t("settings.remoteSignOut")}</Text>
						</Button>
					</View>
				);
			}}
		</View>
	);
}

function ConnectedWorkspace(props: {
	client: HostClient;
	hostId: string;
	connectionState: () => WebRemoteConnectionState;
	recoveryState: () => WebRemoteRecoveryState;
	canUseWorkspace: (...methods: HostApiMethodName[]) => boolean;
	onReconnect: () => void;
	onSignOut?: () => void;
}) {
	const { client, hostId } = props;
	const chat = new ChatTranscriptStore(client, conversationContext());
	const store = new AppStore(client, chat);
	const catalog = new ModelCatalogStore(client);
	const runConfig = new ChatRunConfigStore(client, catalog.state);
	const toasts = new AppToasts();
	const queue = new RemoteChatQueue(client);
	const extensionUi = new RemoteExtensionUi(client, toasts);
	const tabStorage = browserSessionStorage();
	const workspaceStorage =
		tabStorage && createWebWorkspaceStorage(tabStorage, hostId);
	workspaceStorage?.restoreDrafts((target, text) =>
		store.setUnsentDraft(target, text),
	);
	const initialProjectId = workspaceStorage?.readActiveProject();
	const activeProjectId = computed(() => store.state().navigation.projectId);
	effect(() => {
		const projectId = activeProjectId();
		if (projectId) workspaceStorage?.writeActiveProject(projectId);
	});
	const composer = createWorkspaceComposer({
		client,
		hostId,
		shell: webDesktopShell,
		store,
		chat,
		catalog,
		runConfig,
		queue,
		toasts,
		draftTextStorage: workspaceStorage?.draftText,
		waitForStartupApproval: (sessionKey) =>
			extensionUi.waitForStartupApproval(sessionKey),
	});

	composer.followBackgroundSessions();
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
	followRunConfig(store, runConfig, catalog, chat);

	let alive = true;
	const forkDisabled = () =>
		props.connectionState() !== "connected" ||
		!client.hasMethod("chat.rpc") ||
		chat.state().status !== "ready" ||
		composer.state().sending ||
		composer.running() ||
		composer.readOnly();
	const forker = new SessionForker(client, {
		target: () => openChatTarget(store.state()),
		messages: () => chat.messages(),
		disabled: forkDisabled,
		onForked: (projectId, sessionPath, source) => {
			void store.loadSessions(projectId, false).then(() => {
				if (
					alive &&
					source === openChatTarget(store.state())?.sessionKey &&
					store.state().navigation.projectId === projectId
				) {
					store.selectSession(projectId, sessionPath);
				}
			});
		},
	});
	effect(() => {
		const notice = forker.state().notice;
		if (!notice) return;
		untracked(() => {
			toasts.show({
				variant: notice.kind,
				title: notice.title,
				description: notice.description,
			});
			forker.dismissNotice();
		});
	});

	// Requests and queue updates are not included in bootstrap. Read the stream
	// directly so replayed events at or below the bootstrap cut also reach them.
	const liveEvents = client.connectEvents({
		onStatus: () => {},
		onMessage: (message) => {
			if (message.type === "resyncRequired") queue.reset();
			if (message.type !== "events") return;
			for (const event of message.events) {
				extensionUi.receive(event, composer);
				queue.receive(event);
			}
		},
	});

	cleanup(() => {
		alive = false;
		extensionUi.dispose();
		void liveEvents.then((disconnect) => disconnect());
		store.stop();
	});

	void store.preloadThemeSettings().catch(() => undefined);
	void store.start();

	return (
		<MobileAppShell
			store={store}
			shell={webDesktopShell}
			chat={chat}
			composer={composer}
			initialProjectId={initialProjectId}
			queue={queue}
			extensionUi={extensionUi}
			forker={forker}
			forkDisabled={forkDisabled}
			runConfig={runConfig}
			catalog={catalog}
			searchSessions={client}
			connectionState={props.connectionState}
			recoveryState={props.recoveryState}
			onReconnect={props.onReconnect}
			onSignOut={props.onSignOut}
			workspaceClient={client}
			canUseWorkspace={props.canUseWorkspace}
			onPauseCacheKeepAlive={(sessionKey) =>
				void client.pauseCacheKeepAlive(sessionKey).catch((error: unknown) => {
					showToast(toasts, {
						variant: "error",
						title: t("settings.cacheKeepAlivePauseAction"),
						description: userErrorMessage(error),
					});
				})
			}
			onDefaultWorkspaceShown={(connectionId, shown) => {
				void client
					.savePreferences({
						defaultWorkspaceVisibility: { [connectionId]: shown },
					})
					.catch((error: unknown) => {
						console.warn("Failed to save default workspace visibility", error);
					});
			}}
			readProjectImage={(projectId, path) =>
				client.readProjectImage(projectId, path)
			}
			readHistoryImage={(projectId, sessionPath, imageId) =>
				client.readHistoryImage(projectId, sessionPath, imageId)
			}
			toasts={toasts}
		/>
	);
}
