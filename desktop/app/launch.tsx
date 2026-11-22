import { computed, mount, Storage } from "nsh";
import { displays, isAvailable, Window, type WindowRef } from "nsh/desktop";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { ComposerStore } from "../composer/composer-store";
import { AppStore } from "../state/app-store";
import { ChatRunConfigStore } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { ModelCatalogStore } from "../state/model-catalog";
import { TerminalStore } from "../state/terminal-store";
import manifest from "../nsh.json";
import { AppShell, type AppShellProps, StartupFrame } from "./AppShell";
import { showStartupTheme } from "./appearance";
import {
	defaultDesktopNotifications,
	type DesktopNotificationsApi,
} from "./desktop-notifications";
import {
	connectDesktopShell,
	type DesktopSettingsClient,
} from "./desktop-shell";
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

/** Set once the main window has taken its first-launch size. */
const INITIAL_WINDOW_SIZED_KEY = "pilo.initialWindowSized";
/** The share of the display's usable area the first window takes. */
const INITIAL_WINDOW_SHARE = { width: 0.7, height: 0.92 } as const;
/** The first window's largest size: past it, a large display shows it centered. */
const INITIAL_WINDOW_MAX = { width: 1200, height: 960 } as const;

/**
 * Sizes the main window to its display on the app's first launch and
 * centers it there; later launches keep where the user left it
 * (`restoreBounds`). False when it left the window as it was.
 */
async function sizeMainWindowOnFirstLaunch(main: WindowRef) {
	const sized = await Storage.getItem(INITIAL_WINDOW_SIZED_KEY).catch(
		() => null,
	);
	if (sized) return false;
	const state = main.state();
	const display =
		state?.display ?? displays().find((d) => d.primary) ?? displays()[0];
	if (!state || state.mode !== "normal" || !display) return false;
	const area = display.visibleBounds;
	const { size } = state.bounds;
	const { size: content } = state.contentBounds;
	const minSize = manifest.window.minSize;
	// The bounds are the outer frame; the minimum size is the content's.
	const minWidth = minSize.width + (size.width - content.width);
	const minHeight = minSize.height + (size.height - content.height);
	// A display smaller than the least window is `fitMainWindow`'s.
	if (area.size.width < minWidth || area.size.height < minHeight) return false;
	const width = Math.min(
		Math.max(
			Math.round(area.size.width * INITIAL_WINDOW_SHARE.width),
			minWidth,
		),
		INITIAL_WINDOW_MAX.width,
		area.size.width,
	);
	const height = Math.min(
		Math.max(
			Math.round(area.size.height * INITIAL_WINDOW_SHARE.height),
			minHeight,
		),
		INITIAL_WINDOW_MAX.height,
		area.size.height,
	);
	main.setBounds({
		origin: {
			x: Math.round(area.origin.x + (area.size.width - width) / 2),
			y: Math.round(area.origin.y + (area.size.height - height) / 2),
		},
		size: { width, height },
		animated: false,
	});
	void Storage.setItem(INITIAL_WINDOW_SIZED_KEY, "1").catch(
		(error: unknown) => {
			console.warn("Failed to save the first-launch window size", error);
		},
	);
	return true;
}

function fitMainWindow(main: WindowRef) {
	const [display, secondDisplay] = displays();
	const state = main.state();
	// Leave multi-display layouts and restored window modes to nsh.
	if (!display || secondDisplay || !state || state.mode !== "normal") return;
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
export async function launch(
	pilo: PiloNative,
	desktopSettings?: DesktopSettingsClient,
	notifications: DesktopNotificationsApi = defaultDesktopNotifications(),
) {
	const client = new NshPiloClient(pilo);
	const chat = new ChatTranscriptStore(client, conversationContext());
	let notify: ((event: PiloClientEvent) => Promise<void>) | undefined;
	let desktop: ReturnType<typeof connectDesktopShell> | undefined;
	const store = new AppStore(client, chat, (event) => {
		if (event.type === "configuration_changed") {
			void desktop?.refreshExitOnClose();
		}
		void notify?.(event).catch((error: unknown) => {
			console.warn("Failed to send Pilo session notification", error);
		});
	});
	const main = isAvailable ? Window.get("main") : null;
	// The first-launch size fits its display already; `fitMainWindow` would
	// read the bounds from before it.
	if (main && !(await sizeMainWindowOnFirstLaunch(main))) fitMainWindow(main);
	desktop =
		main && desktopSettings
			? connectDesktopShell(main, desktopSettings, async () => {
					store.stop();
					await client.shutdown();
				})
			: undefined;
	if (desktop)
		notify = connectSessionNotifications(client, store, desktop, notifications);
	const catalog = new ModelCatalogStore(client);
	const runConfig = new ChatRunConfigStore(client, catalog.state);
	const composer: ComposerStore = new ComposerStore({
		client,
		app: store.state,
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
	endLeftTemporaryChats(store, (sessionKey, reason) =>
		client.stopChat(sessionKey, reason),
	);
	followOpenSessionRead(store);
	followRunConfig(store, runConfig, catalog);
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
		assistanceClient: client,
		runConfig,
		catalog,
		forker,
		searchSessions: client,
		settings: client,
		projectClient: client,
		desktop,
		notifications,
		sidebarSettings,
		terminals: new TerminalStore(client),
		openProjectInApp: (projectId, app, path) =>
			client.openProjectInApp(projectId, app, path),
		onRenameSession: (projectId, sessionPath, title) =>
			void store.renameSession(projectId, sessionPath, title),
		readProjectImage: (projectId, path) =>
			client.readProjectImage(projectId, path),
	};
	const showShell = computed(() => {
		const { themeSettings, status } = store.state();
		return (
			themeSettings !== null ||
			status.type === "failed" ||
			status.type === "closed"
		);
	});
	mount(
		() => () =>
			showShell() ? (
				<AppShell {...shellProps} />
			) : (
				<StartupFrame
					claude={startupTheme?.themeFamily === "claude"}
					sidebarWidth={sidebarSettings.width}
				/>
			),
	);
	// The normal sync still reloads the theme after its bootstrap cut.
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
