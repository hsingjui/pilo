import { cleanup, computed, mount, signal, View } from "nsh";
import { Head } from "nsh/web";

import { showStartupTheme } from "./app/appearance";
import { initializeI18n, t } from "./app/i18n";
import {
	conversationContext,
	endLeftTemporaryChats,
	followOpenSession,
	followRunConfig,
} from "./app/open-chat";
import { followOpenSessionRead } from "./app/read-open-session";
import { createSessionAutoTitle } from "./app/session-auto-title";
import { AppToasts } from "./app/app-toasts";
import {
	loadRemoteDeviceToken,
	saveRemoteDeviceToken,
	WebRemotePiloClient,
} from "./client/web-remote-client";
import { ComposerStore } from "./composer/composer-store";
import {
	MobileAppShell,
	MobileAuthRequiredView,
} from "./mobile/mobile-app-shell";
import { AppStore } from "./state/app-store";
import { ChatRunConfigStore } from "./state/chat-run-config";
import { ChatTranscriptStore } from "./state/chat-transcript-store";
import { ModelCatalogStore } from "./state/model-catalog";

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
	const composer = new ComposerStore({
		client,
		app: store.state,
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

	cleanup(() => {
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
			runConfig={runConfig}
			catalog={catalog}
			searchSessions={client}
			connectionState={client.connectionState}
			recoveryState={client.recoveryState}
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
	const token = signal<string | null>(null);
	const ready = signal(false);
	const authError = signal<string | null>(null);
	const tokens = computed(() => {
		const value = token();
		return value ? [value] : [];
	});

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

	return (
		<View class="flex-1 bg-background">
			<Head
				title="Pilo"
				meta={[
					{
						name: "viewport",
						content:
							"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
					},
				]}
			/>
			{() => {
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
