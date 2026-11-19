import { mount } from "nsh";

import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { AppShell } from "./AppShell";
import { appLocale } from "./i18n";
import { conversationContext, followOpenSession } from "./open-chat";

/**
 * Starts the app on `pilo`: shows the shell, loads the app state and keeps
 * the open session's transcript read.
 */
export async function launch(pilo: PiloNative) {
	const client = new NshPiloClient(pilo);
	const chat = new ChatTranscriptStore(client, conversationContext());
	const store = new AppStore(client, chat);
	followOpenSession(store, chat);
	mount(AppShell, { store, chat });
	await client
		.savePreferences({ locale: appLocale() }, true)
		.catch((error: unknown) => {
			console.warn("Failed to initialize Host locale", error);
		});
	return store.start();
}
