import { mount } from "nsh";

import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { AppShell } from "./AppShell";
import { appLocale } from "./i18n";

/** Starts the app on `pilo`: shows the shell and loads the app state. */
export async function launch(pilo: PiloNative) {
	const client = new NshPiloClient(pilo);
	const store = new AppStore(client);
	mount(AppShell, { store });
	await client
		.savePreferences({ locale: appLocale() }, true)
		.catch((error: unknown) => {
			console.warn("Failed to initialize Host locale", error);
		});
	return store.start();
}
