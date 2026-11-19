import { mount } from "nsh";

import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { AppShell } from "./AppShell";

/** Starts the app on `pilo`: shows the shell and loads the app state. */
export function launch(pilo: PiloNative) {
	const store = new AppStore(new NshPiloClient(pilo));
	mount(AppShell, { store });
	return store.start();
}
