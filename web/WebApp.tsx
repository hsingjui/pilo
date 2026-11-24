import {
	cleanup,
	computed,
	effect,
	mount,
	signal,
	untracked,
	UrlScheme,
	View,
} from "nsh";
import { Head } from "nsh/web";

import { userErrorMessage } from "@shared/app-error";
import { isRemotePairingUrl } from "@shared/remote-pairing";

import { AppToasts, showToast } from "../app/shell/app-toasts";
import { showStartupTheme } from "../app/shell/appearance";
import { appLocale, initializeI18n, t } from "../app/shell/i18n";
import {
	conversationContext,
	endLeftTemporaryChats,
	followOpenSession,
	followRunConfig,
	openChatTarget,
} from "../app/shell/open-chat";
import { followOpenSessionRead } from "../app/shell/read-open-session";
import { createSessionAutoTitle } from "../app/shell/session-auto-title";
import { SessionForker } from "../app/shell/session-fork";
import { ComposerStore } from "../app/composer/composer-store";
import { AppStore } from "../app/state/app-store";
import { ChatRunConfigStore } from "../app/state/chat-run-config";
import { ChatTranscriptStore } from "../app/state/chat-transcript-store";
import { ModelCatalogStore } from "../app/state/model-catalog";
import {
	MobileAppShell,
	MobileAuthRequiredView,
	type AuthExpiryReminder,
} from "./mobile-app-shell";
import { RemotePairingPage } from "./pairing-page";
import { RemoteChatQueue } from "./remote-chat-queue";
import { RemoteExtensionUi } from "./remote-extension-ui";
import {
	browserSessionStorage,
	loadRemoteDeviceToken,
	resolveCurrentPageUrl,
	saveRemoteDeviceToken,
	WebRemotePiloClient,
} from "./web-remote-client";

/** Show a renewal reminder when device authorization expires within 7 days. */
const RENEW_REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const ACTIVE_PROJECT_KEY = "pilo.web.activeProject.v1";
const DRAFT_TEXT_KEY_PREFIX = "pilo.web.draftText.v1:";

function formatExpiryDate(ms: number, language: string): string {
	return new Date(ms).toLocaleString(language, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

initializeI18n();

function MobileRemoteWorkspace(props: {
	token: string;
	onAuthExpired: () => void;
}) {
	const client = new WebRemotePiloClient(props.token, {
		onAuthExpired: props.onAuthExpired,
	});
	const chat = new ChatTranscriptStore(client, conversationContext());
	const store = new AppStore(client, chat);
	const catalog = new ModelCatalogStore(client);
	const runConfig = new ChatRunConfigStore(client, catalog.state);
	const toasts = new AppToasts();
	const queue = new RemoteChatQueue(client);
	const extensionUi = new RemoteExtensionUi(client, toasts);
	const tabStorage = browserSessionStorage();
	const readTabValue = (key: string) => {
		try {
			return tabStorage?.getItem(key) ?? null;
		} catch {
			return null;
		}
	};
	const writeTabValue = (key: string, value: string) => {
		try {
			if (value) tabStorage?.setItem(key, value);
			else tabStorage?.removeItem(key);
		} catch {
			// Browser storage may be disabled or full; keep the live draft usable.
		}
	};
	const initialProjectId = readTabValue(ACTIVE_PROJECT_KEY);
	const activeProjectId = computed(() => store.state().navigation.projectId);
	effect(() => {
		const projectId = activeProjectId();
		if (projectId) writeTabValue(ACTIVE_PROJECT_KEY, projectId);
	});
	const composer = new ComposerStore({
		client,
		app: store.state,
		draftTextStorage: tabStorage && {
			read: (projectId) => readTabValue(DRAFT_TEXT_KEY_PREFIX + projectId),
			write: (projectId, value) =>
				writeTabValue(DRAFT_TEXT_KEY_PREFIX + projectId, value),
		},
		queue,
		waitForStartupApproval: (sessionKey) =>
			extensionUi.waitForStartupApproval(sessionKey),
		catalog,
		beforeSend: (sessionKey) => runConfig.prepareToSend(sessionKey),
		transcript: chat,
		onPromptStarted: createSessionAutoTitle(client, (target, error) =>
			composer.setStatus(
				`${t("settings.automaticNamingFailed")}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				target.sessionKey,
			),
		),
		onNewChat: () => {
			const projectId =
				composer.target()?.projectId ?? store.state().navigation.projectId;
			if (projectId) store.selectProject(projectId);
		},
		onCompacted: () => {
			void runConfig.refresh();
		},
		onNotice: (notice) => toasts.show(notice),
	});

	followOpenSession(store, chat);
	endLeftTemporaryChats(store, (sessionKey, reason) =>
		client.stopChat(sessionKey, reason),
	);
	followOpenSessionRead(store);
	followRunConfig(store, runConfig, catalog, chat);

	let alive = true;
	const forkDisabled = () =>
		client.connectionState() !== "connected" ||
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

	// Check device authorization expiry once on load.
	const expiringAtMs = signal<number | null>(null);
	const renewingAuth = signal(false);

	void client
		.loadDeviceAuth()
		.then(({ expiresAtMs }) => {
			if (!alive) return;
			if (expiresAtMs - Date.now() <= RENEW_REMINDER_WINDOW_MS) {
				expiringAtMs.set(expiresAtMs);
			}
		})
		.catch(() => {
			// 401 is handled inside WebRemotePiloClient; transient failures stay quiet.
		});

	const renewAuth = () => {
		if (!alive || renewingAuth()) return;
		renewingAuth.set(true);
		void client
			.renewDeviceAuth()
			.then(({ expiresAtMs }) => {
				if (!alive) return;
				expiringAtMs.set(null);
				showToast(toasts, {
					variant: "success",
					title: t("settings.remoteAuthorizationRenewed"),
					description: t("settings.remoteAuthorizationExpiresAt", {
						date: formatExpiryDate(expiresAtMs, appLocale()),
					}),
				});
			})
			.catch((error: unknown) => {
				if (!alive) return;
				if (error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED") {
					return;
				}
				showToast(toasts, {
					variant: "error",
					title: t("settings.remoteAuthorizationRenewFailed"),
					description: userErrorMessage(error),
				});
			})
			.finally(() => {
				if (alive) renewingAuth.set(false);
			});
	};

	const authExpiryReminder = computed<AuthExpiryReminder | null>(() => {
		const deadline = expiringAtMs();
		if (deadline === null) return null;
		return {
			description: t("settings.remoteAuthorizationExpiresAt", {
				date: formatExpiryDate(deadline, appLocale()),
			}),
			renewing: renewingAuth(),
			renew: renewAuth,
			dismiss: () => expiringAtMs.set(null),
		};
	});

	cleanup(() => {
		alive = false;
		extensionUi.dispose();
		void liveEvents.then((disconnect) => disconnect());
		store.stop();
		client.dispose();
	});

	void store.preloadThemeSettings().catch(() => undefined);
	void store.start();

	return (
		<MobileAppShell
			store={store}
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
			connectionState={client.connectionState}
			recoveryState={client.recoveryState}
			authExpiryReminder={authExpiryReminder}
			onReconnect={() => client.reconnectNow()}
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

function WebAppRoot() {
	const currentUrl = signal(resolveCurrentPageUrl());
	const isPairingRoute = computed(() => isRemotePairingUrl(currentUrl()));
	const token = signal<string | null>(null);
	const ready = signal(false);
	const authError = signal<string | null>(null);
	const tokens = computed(() => {
		const value = token();
		return value ? [value] : [];
	});

	const stopUrlWatch = UrlScheme.on("change", ({ url }) => {
		currentUrl.set(url);
	});
	cleanup(stopUrlWatch);

	void Promise.all([showStartupTheme(), loadRemoteDeviceToken()])
		.then(([, loadedToken]) => {
			token.set(loadedToken);
		})
		.finally(() => {
			ready.set(true);
		});

	const handleAuthExpired = () => {
		token.set(null);
		authError.set(t("settings.remoteAuthorizationExpired"));
	};

	const handleSubmitToken = (value: string) => {
		authError.set(null);
		void saveRemoteDeviceToken(value).then(() => {
			token.set(value);
		});
	};

	const enterWorkspace = (pairedToken?: string) => {
		authError.set(null);
		if (pairedToken) {
			token.set(pairedToken);
		} else {
			void loadRemoteDeviceToken().then((loaded) => {
				token.set(loaded);
			});
		}
		currentUrl.set(resolveCurrentPageUrl());
	};

	return (
		<View class="flex-1 bg-background">
			<Head
				title="Pilo"
				lang={appLocale()}
				meta={[
					{
						name: "viewport",
						content:
							"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
					},
					{ name: "apple-mobile-web-app-capable", content: "yes" },
					{
						name: "apple-mobile-web-app-status-bar-style",
						content: "black-translucent",
					},
					{ name: "apple-mobile-web-app-title", content: "Pilo" },
				]}
			/>
			{() => {
				if (isPairingRoute()) {
					return (
						<RemotePairingPage
							onPaired={(pairedToken) => enterWorkspace(pairedToken)}
							onOpenApp={() => enterWorkspace()}
						/>
					);
				}
				if (!ready()) return <View class="flex-1 bg-background" />;
				if (!token()) {
					return (
						<MobileAuthRequiredView
							error={authError}
							onSubmitToken={handleSubmitToken}
						/>
					);
				}
				return (
					<Each of={tokens()} key={(value) => value}>
						{(value) => (
							<MobileRemoteWorkspace
								token={value()}
								onAuthExpired={handleAuthExpired}
							/>
						)}
					</Each>
				);
			}}
		</View>
	);
}

mount(WebAppRoot);
