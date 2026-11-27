import { host, mount, openUrl, Text } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

import { initializeI18n } from "../shell/i18n";
import { launch } from "../shell/launch";
import { createNativeDesktopShell } from "../shell/native-desktop-shell";
import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";

async function run() {
	const fixture = new BootstrapFixture();
	try {
		if (host.params.mode === "saved" || host.params.mode === "reopen") {
			const previous = new Pilo(fixture.dataDir());
			try {
				if (host.params.mode === "saved") {
					await previous.savePreferences({ locale: "en-US" });
				} else {
					await previous.savePreferences({ locale: "zh-CN" }, true);
				}
			} finally {
				await previous.shutdown();
			}
		}
		const pilo = new Pilo(fixture.dataDir());
		try {
			const system = initializeI18n();
			await launch(pilo, createNativeDesktopShell(pilo));
			const preferences = await new NshPiloClient(pilo).loadPreferences();
			return `startup locale: ${system}; Host: ${preferences.values.locale}`;
		} finally {
			await pilo.shutdown();
		}
	} finally {
		fixture.dispose();
	}
}

const show = (message: string) => mount(() => <Text>{message}</Text>);
if (host.params.mode === "pending") {
	initializeI18n();
	const pendingSeed: Pick<PiloNative, "savePreferences" | "nextEvents"> = {
		savePreferences: () => new Promise<never>(() => {}),
		nextEvents: () => {
			throw new Error("the store started before the locale seed settled");
		},
	};
	void launch(pendingSeed as PiloNative, { openExternal: openUrl }).catch(
		(error: unknown) => show(String(error)),
	);
} else {
	void run().then(show, (error: unknown) => show(String(error)));
}
