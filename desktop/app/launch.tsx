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
} from "./open-chat";
import { followOpenSessionRead } from "./read-open-session";

/**
 * Starts the app on `pilo`: shows the shell, loads the app state, keeps the
 * open session's transcript read and marks its finished turns as seen.
 */
export async function launch(pilo: PiloNative) {
	const client = new NshPiloClient(pilo);
	const chat = new ChatTranscriptStore(client, conversationContext());
	const store = new AppStore(client, chat);
	const composer = new ComposerStore({ client, app: store.state });
	const catalog = new ModelCatalogStore(client);
	const runConfig = new ChatRunConfigStore(client, catalog.state);
	followOpenSession(store, chat);
	followOpenSessionRead(store);
	followRunConfig(store, runConfig, catalog);
	mount(AppShell, {
		store,
		chat,
		composer,
		runConfig,
		catalog,
		onRenameSession: (projectId, sessionPath, title) =>
			void client
				.updateSessionUiState(
					sessionPath,
					{
						pinned:
							store
								.state()
								.sessionIndexes[projectId]?.sessions.find(
									(entry) => entry.sessionPath === sessionPath,
								)?.pinned ?? false,
						titleOverride: title,
					},
					projectId,
				)
				.catch((error: unknown) => console.warn("Failed to rename", error)),
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
