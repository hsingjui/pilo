import { computed, effect, mount } from "nsh";
import {
	currentWindow,
	displays,
	isAvailable,
	type Display,
	type WindowRef,
	type WindowState,
} from "nsh/desktop";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { ComposerStore } from "../composer/composer-store";
import { AppStore } from "../state/app-store";
import { ChatQueueStore } from "../state/chat-queue-store";
import { ChatRunConfigStore } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { ModelCatalogStore } from "../state/model-catalog";
import { TerminalStore } from "../state/terminal-store";
import { WorkspaceStore } from "../state/workspace-store";
import manifest from "../../nsh.json";
import { AppShell, type AppShellProps, StartupFrame } from "./AppShell";
import { AppToasts } from "./app-toasts";
import { showStartupTheme } from "./appearance";
import { connectDesktopShell, type DesktopShell } from "./desktop-shell";
import { appLocale, t } from "./i18n";
import {
	conversationContext,
	endLeftTemporaryChats,
	followOpenSession,
	followRunConfig,
	openChatTarget,
} from "./open-chat";
import { followOpenSessionRead } from "./read-open-session";
import { SessionForker } from "./session-fork";
import { createSessionAutoTitle } from "./session-auto-title";
import { connectSessionNotifications } from "./session-notifications";
import { SidebarSettingsStore } from "./sidebar-settings";

function fitMainWindow(main: WindowRef, state: WindowState, display: Display) {
	const area = display.visibleBounds;
	const { origin, size } = state.bounds;
	const { size: content } = state.contentBounds;
	const minSize = manifest.window.minSize;
	const availableWidth = area.size.width - (size.width - content.width);
	const availableHeight = area.size.height - (size.height - content.height);
	if (availableWidth <= 0 || availableHeight <= 0) return;
	const minWidth = Math.max(1, Math.floor(availableWidth * 0.9));
	const minHeight = Math.max(1, Math.floor(availableHeight * 0.9));
	if (minWidth < minSize.width || minHeight < minSize.height) {
		main.set({
			minSize: {
				width: Math.min(minSize.width, minWidth),
				height: Math.min(minSize.height, minHeight),
			},
		});
	}
	const width = Math.min(size.width, area.size.width);
	const height = Math.min(size.height, area.size.height);
	const x = Math.min(
		Math.max(origin.x, area.origin.x),
		area.origin.x + area.size.width - width,
	);
	const y = Math.min(
		Math.max(origin.y, area.origin.y),
		area.origin.y + area.size.height - height,
	);
	if (
		width !== size.width ||
		height !== size.height ||
		x !== origin.x ||
		y !== origin.y
	) {
		main.setBounds({ origin: { x, y }, size: { width, height } });
	}
}

/**
 * Starts the app on `pilo`: shows the shell, loads the app state, keeps the
 * open session's transcript read and marks its finished turns as seen.
 */
export async function launch(pilo: PiloNative, shell: DesktopShell) {
	const client = new NshPiloClient(pilo);
	const chat = new ChatTranscriptStore(client, conversationContext());
	const workspace = new WorkspaceStore();
	const terminals = new TerminalStore(client);
	let notify: ((event: PiloClientEvent) => Promise<void>) | undefined;
	let desktop: ReturnType<typeof connectDesktopShell> | undefined;
	const store = new AppStore(
		client,
		chat,
		(event) => {
			if (event.type === "configuration_changed") {
				void desktop?.refreshExitOnClose();
			}
			void notify?.(event).catch((error: unknown) => {
				console.warn("Failed to send Pilo session notification", error);
			});
		},
		(projectId) =>
			terminals.activeTab(projectId) === null &&
			!workspace.isGitActive(projectId) &&
			workspace.activeFile(projectId) === null,
	);
	const catalog = new ModelCatalogStore(client);
	const runConfig = new ChatRunConfigStore(client, catalog.state);
	const toasts = new AppToasts();
	const queue = new ChatQueueStore(client);
	store.subscribeEventMessages((message) => {
		if (!message || message.type === "resyncRequired") {
			queue.reset();
			return;
		}
		if (message.type !== "events") return;
		for (const event of message.events) queue.receive(event);
	});
	const nameSession = createSessionAutoTitle(client, (target, error) => {
		composer.setStatus(
			`${t("settings.automaticNamingFailed")}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			target.sessionKey,
		);
	});
	const composer: ComposerStore = new ComposerStore({
		client,
		shell,
		app: store.state,
		activeModel: () => runConfig.state()?.model ?? null,
		catalog,
		queue,
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
			terminals.select(null);
			workspace.selectChat(projectId ?? undefined);
			if (projectId) store.selectProject(projectId);
		},
		onCompacted: () => {
			void runConfig.refresh();
		},
		onNotice: (notice) => toasts.show(notice),
	});
	const forker = new SessionForker(client, {
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
	// The first frame takes the saved theme and sidebar width, so a launch or
	// reload neither flashes the default theme nor resizes its outline.
	const sidebarSettings = new SidebarSettingsStore();
	const [startupTheme] = await Promise.all([
		showStartupTheme(),
		sidebarSettings.load().catch((error: unknown) => {
			console.warn("Failed to load the sidebar settings", error);
		}),
	]);
	const shellProps: AppShellProps = {
		store,
		chat,
		composer,
		queue,
		assistanceClient: client,
		runConfig,
		catalog,
		forker,
		searchSessions: client,
		settings: client,
		projectClient: client,
		shell,
		sidebarSettings,
		toasts,
		workspace,
		terminals,
		openProjectInApp: shell.openProjectInApp,
		openFileLink: shell.openFileLink,
		git: client,
		onRenameSession: (projectId, sessionPath, title) =>
			store.renameSession(projectId, sessionPath, title),
		onPauseCacheKeepAlive: (sessionKey) =>
			client.pauseCacheKeepAlive(sessionKey),
		readProjectImage: (projectId, path) =>
			client.readProjectImage(projectId, path),
		readHistoryImage: (projectId, sessionPath, imageId) =>
			client.readHistoryImage(projectId, sessionPath, imageId),
		saveImage: shell.saveImage,
	};
	const showShell = computed(() => {
		const { themeSettings, status } = store.state();
		return (
			themeSettings !== null ||
			status.type === "failed" ||
			status.type === "closed"
		);
	});
	mount(() => {
		composer.followBackgroundSessions();
		if (isAvailable) {
			// nsh creates the implicit main window as part of mount.
			const main = currentWindow();
			main.set({ title: manifest.name });
			if (shell.settings) {
				desktop = connectDesktopShell(
					main,
					shell.settings,
					async () => {
						store.stop();
						await client.shutdown();
					},
					shell.dock,
				);
			}
			if (desktop && shell.notifications) {
				notify = connectSessionNotifications(
					client,
					store,
					desktop,
					shell.notifications,
					{
						isViewingSession: (projectId, sessionPath) =>
							store.isViewingSession(projectId, sessionPath),
						onSelectTarget: (projectId) => {
							terminals.select(null);
							workspace.selectChat(projectId);
						},
					},
				);
			}
			// nsh applies the manifest defaults or restores saved geometry first.
			let fitted = false;
			effect(() => {
				if (fitted) return;
				const state = main.state();
				if (!state) return;
				const screens = displays();
				const display =
					state.display ??
					screens.find((screen) => screen.primary) ??
					screens[0];
				if (!display) return;
				fitted = true;
				if (state.mode === "normal" && !state.minimized) {
					fitMainWindow(main, state, display);
				}
			});
		}
		return () =>
			showShell() ? (
				<AppShell {...shellProps} desktop={desktop} />
			) : (
				<StartupFrame
					claude={startupTheme?.themeFamily === "claude"}
					sidebarWidth={sidebarSettings.width}
				/>
			);
	});
	// Overlap initial theme preload with locale seeding before store bootstrap.
	void store.preloadThemeSettings().catch((error: unknown) => {
		console.warn("Failed to preload Host theme", error);
	});
	await client
		.savePreferences({ locale: appLocale() }, true)
		.catch((error: unknown) => {
			console.warn("Failed to initialize Host locale", error);
		});
	if (!desktop?.isQuitting()) await store.start();
}
