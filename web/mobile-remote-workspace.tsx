import { cleanup, computed, effect, untracked } from "nsh";

import {
	chatSessionKey,
	parseChatSessionKey,
} from "@shared/api/chat-session-key";
import { runtimeSessionPathKey } from "@shared/chat/chat-session-runtime-model";
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
import { createSessionAutoTitle } from "../app/shell/session-auto-title";
import { SessionForker } from "../app/shell/session-fork";
import {
	ComposerStore,
	type ComposerTarget,
} from "../app/composer/composer-store";
import {
	createDraftSessionId,
	isDraftSessionId,
	isTemporarySessionKey,
} from "../app/state/app-state";
import { AppStore } from "../app/state/app-store";
import { ChatRunConfigStore } from "../app/state/chat-run-config";
import { ChatTranscriptStore } from "../app/state/chat-transcript-store";
import { ModelCatalogStore } from "../app/state/model-catalog";
import { MobileAppShell } from "./mobile-app-shell";
import { RemoteChatQueue } from "./remote-chat-queue";
import { RemoteExtensionUi } from "./remote-extension-ui";
import { webDesktopShell } from "./web-desktop-shell";
import { browserSessionStorage } from "./web-remote-browser";
import { WebRemotePiloClient } from "./web-remote-client";

const ACTIVE_PROJECT_KEY = "pilo.web.activeProject.v1";
const DRAFT_TEXT_KEY_PREFIX = "pilo.web.draftText.v3:";
const SAVED_DRAFT_TEXT_KEY_PREFIX = "pilo.web.savedDraftText.v1:";
const LEGACY_SESSION_TEXT_PREFIX = "pilo.web.draftText.v2:";
const LEGACY_PROJECT_TEXT_PREFIX = "pilo.web.draftText.v1:";

export interface MobileRemoteWorkspaceProps {
	token: string;
	onAuthExpired: () => void;
	onSignOut?: () => void;
}

export function MobileRemoteWorkspace(props: MobileRemoteWorkspaceProps) {
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
		if (!tabStorage) return false;
		try {
			if (value) tabStorage.setItem(key, value);
			else tabStorage.removeItem(key);
			return true;
		} catch {
			// Browser storage may be disabled or full; keep the live draft usable.
			return false;
		}
	};
	const draftStorageKey = ({
		sessionKey,
		projectId,
		sessionPath,
	}: ComposerTarget) => {
		if (isTemporarySessionKey(sessionKey)) return null;
		return sessionPath
			? SAVED_DRAFT_TEXT_KEY_PREFIX +
					chatSessionKey(projectId, runtimeSessionPathKey(sessionPath))
			: DRAFT_TEXT_KEY_PREFIX + sessionKey;
	};
	try {
		const keys = Array.from({ length: tabStorage?.length ?? 0 }, (_, index) =>
			tabStorage?.key(index),
		);
		for (const key of keys) {
			if (!key) continue;
			if (key.startsWith(DRAFT_TEXT_KEY_PREFIX)) {
				const text = readTabValue(key);
				if (!text?.trim()) continue;
				const sessionKey = key.slice(DRAFT_TEXT_KEY_PREFIX.length);
				const parsed = parseChatSessionKey(sessionKey);
				if (parsed && isDraftSessionId(parsed[1])) {
					store.setUnsentDraft({ sessionKey, projectId: parsed[0] }, text);
				}
				continue;
			}
			const legacyPrefix = [
				LEGACY_PROJECT_TEXT_PREFIX,
				`${LEGACY_SESSION_TEXT_PREFIX}draft:`,
			].find((prefix) => key.startsWith(prefix));
			if (!legacyPrefix) continue;
			const text = readTabValue(key);
			if (!text?.trim()) continue;
			const projectId = key.slice(legacyPrefix.length);
			const sessionKey = chatSessionKey(projectId, createDraftSessionId());
			if (writeTabValue(DRAFT_TEXT_KEY_PREFIX + sessionKey, text)) {
				writeTabValue(key, "");
				store.setUnsentDraft({ sessionKey, projectId }, text);
			}
		}
	} catch {
		// Browser storage can be unavailable even after retrieving the object.
	}
	const initialProjectId = readTabValue(ACTIVE_PROJECT_KEY);
	const activeProjectId = computed(() => store.state().navigation.projectId);
	effect(() => {
		const projectId = activeProjectId();
		if (projectId) writeTabValue(ACTIVE_PROJECT_KEY, projectId);
	});
	const nameSession = createSessionAutoTitle(client, (target, error) => {
		composer.setStatus(
			`${t("settings.automaticNamingFailed")}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			target.sessionKey,
		);
	});
	const composer = new ComposerStore({
		client,
		shell: webDesktopShell,
		app: store.state,
		draftTextStorage: tabStorage && {
			read: (target) => {
				const key = draftStorageKey(target);
				if (!key) return null;
				const value = readTabValue(key);
				return (
					value ??
					(target.sessionPath
						? readTabValue(LEGACY_SESSION_TEXT_PREFIX + target.sessionKey)
						: null)
				);
			},
			write: (target, value) => {
				const key = draftStorageKey(target);
				if (!key || !writeTabValue(key, value)) return false;
				if (target.sessionPath)
					writeTabValue(LEGACY_SESSION_TEXT_PREFIX + target.sessionKey, "");
				return true;
			},
		},
		queue,
		waitForStartupApproval: (sessionKey) =>
			extensionUi.waitForStartupApproval(sessionKey),
		catalog,
		activeModel: () => runConfig.state()?.model ?? null,
		beforeSend: (sessionKey, ensureReady, inBackground) =>
			runConfig.prepareToSend(sessionKey, ensureReady, inBackground),
		transcript: chat,
		onPendingDraft: (target, text) => store.setPendingDraft(target, text),
		onUnsentDraft: (target, text) => store.setUnsentDraft(target, text),
		onPromptStarted: (target, text) => {
			store.confirmDraft(target, text);
			nameSession(target, text);
		},
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
			connectionState={client.connectionState}
			recoveryState={client.recoveryState}
			onReconnect={() => client.reconnectNow()}
			onSignOut={props.onSignOut}
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
