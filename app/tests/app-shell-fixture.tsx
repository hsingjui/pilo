import { BootstrapFixture, Pilo } from "app/native";

import "../shell/fonts";
import { initializeI18n } from "../shell/i18n";
import { launch } from "../shell/launch";
import { NshPiloClient } from "../client/nsh-pilo-client";
import { fixtureThemeFamily } from "./fixture-theme";

/**
 * The app as `App.tsx` starts it, on the native runtime over a data
 * directory of its own, whose Host has the test's theme saved.
 */
const fixture = new BootstrapFixture();

async function run() {
	const pilo = new Pilo(fixture.dataDir());
	const themeFamily = await fixtureThemeFamily();
	if (themeFamily !== "lody") {
		await new NshPiloClient(pilo).saveThemeSettings({ themeFamily });
	}
	await launch(pilo);
}

initializeI18n();
void run();
