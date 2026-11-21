import { computed, mount } from "nsh";
import { displays, isAvailable, Window, type WindowRef } from "nsh/desktop";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { ComposerStore } from "../composer/composer-store";
import { AppStore } from "../state/app-store";
import { ChatRunConfigStore } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { ModelCatalogStore } from "../state/model-catalog";
import manifest from "../nsh.json";
import { AppShell, type AppShellProps, StartupFrame } from "./AppShell";
import {
	connectDesktopShell,
	type DesktopSettingsClient,
} from "./desktop-shell";
import { appLocale } from "./i18n";
import {
	conversationContext,
	followOpenSession,
	followRunConfig,
	openChatTarget,
} from "./open-chat";
import { followOpenSessionRead } from "./read-open-session";
import { SessionForker } from "./session-fork";
import { connectSessionNotifications } from "./session-notifications";

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
) {
	const client = new NshPiloClient(pilo);
	const chat = new ChatTranscriptStore(client, conversationContext());
	let notify: ((event: PiloClientEvent) => Promise<void>) | undefined;
	const store = new AppStore(client, chat, (event) => {
		void notify?.(event).catch((error: unknown) => {
			console.warn("Failed to send Pilo session notification", error);
		});
	});
	const main = isAvailable ? Window.get("main") : null;
	if (main) fitMainWindow(main);
	const desktop =
		main && desktopSettings
			? connectDesktopShell(main, desktopSettings, async () => {
					store.stop();
					await client.shutdown();
				})
			: undefined;
	if (desktop) notify = connectSessionNotifications(client, store, desktop);
	const catalog = new ModelCatalogStore(client);
	const runConfig = new ChatRunConfigStore(client, catalog.state);
	const composer = new ComposerStore({
		client,
		app: store.state,
		beforeSend: (sessionKey) => runConfig.prepareToSend(sessionKey),
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
	followOpenSessionRead(store);
	followRunConfig(store, runConfig, catalog);
	const shellProps: AppShellProps = {
		store,
		chat,
		composer,
		runConfig,
		catalog,
		forker,
		searchSessions: client,
		settings: client,
		projectClient: client,
		desktop,
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
		() => () => (showShell() ? <AppShell {...shellProps} /> : <StartupFrame />),
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
