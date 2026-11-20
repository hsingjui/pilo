import { mount } from "nsh";

import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { ComposerStore } from "../composer/composer-store";
import { AppStore } from "../state/app-store";
import { ChatRunConfigStore } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { ModelCatalogStore } from "../state/model-catalog";
import { AppShell } from "./AppShell";
import { appLocale } from "./i18n";
import {
	conversationContext,
	followOpenSession,
	followRunConfig,
	openChatTarget,
} from "./open-chat";
import { followOpenSessionRead } from "./read-open-session";
import { SessionForker } from "./session-fork";

/**
 * Starts the app on `pilo`: shows the shell, loads the app state, keeps the
 * open session's transcript read and marks its finished turns as seen.
 */
export async function launch(pilo: PiloNative) {
	const client = new NshPiloClient(pilo);
	const chat = new ChatTranscriptStore(client, conversationContext());
	const store = new AppStore(client, chat);
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
	mount(AppShell, {
		store,
		chat,
		composer,
		runConfig,
		catalog,
		forker,
		searchSessions: client,
		settings: client,
		projectClient: client,
		onRenameSession: (projectId, sessionPath, title) =>
			void store.renameSession(projectId, sessionPath, title),
		readProjectImage: (projectId, path) =>
			client.readProjectImage(projectId, path),
	});
	await client
		.savePreferences({ locale: appLocale() }, true)
		.catch((error: unknown) => {
			console.warn("Failed to initialize Host locale", error);
		});
	return store.start();
}
