import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import type { ThemeSettings } from "../../src/lib/theme-settings-types";

const fixture = new BootstrapFixture();
const status = signal("loading Host theme settings");
const css = ":root {--primary:#abc;} .card {color:red;}";

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

async function run() {
	fixture.seedLegacyThemeSettings(css);
	const pilo = new Pilo(fixture.dataDir());
	let saved: ThemeSettings;
	try {
		const legacy = (await pilo.loadThemeSettings()) as ThemeSettings;
		assert(
			legacy.revision === 7 &&
				legacy.themeFamily === "custom" &&
				legacy.themeCustomCss === css &&
				legacy.themeCustomTokens?.light?.primary === "#aabbccff" &&
				legacy.themeCustomConversion?.current[0]?.text ===
					".card {color:red;}" &&
				legacy.themeCustomConversion?.savedThemes[0]?.name === "Legacy",
			"legacy settings were not converted on load",
		);
		await expectError(
			pilo.saveThemeSettings([]),
			"theme settings update must be an object",
		);
		await expectError(
			pilo.saveThemeSettings({
				themeCustomTokens: { light: { primary: "not-a-color" } },
			}),
			"issues",
		);
		const patch = {
			theme: "dark",
			themeCustomConversion: { current: [{ text: "injected" }] },
		};
		const patched = (await pilo.saveThemeSettings(patch)) as ThemeSettings;
		assert(
			patched.revision === 8 &&
				patched.theme === "dark" &&
				JSON.stringify(patched.themeCustomConversion) ===
					JSON.stringify(legacy.themeCustomConversion),
			"partial update did not preserve the Host conversion report",
		);

		saved = (await pilo.saveThemeSettings({
			saveCustomTheme: {
				name: "Legacy",
				tokens: { light: { primary: "#112233ff" } },
			},
		})) as ThemeSettings;
		assert(
			saved.revision === 9 &&
				saved.theme === "dark" &&
				saved.themeCustomTokens?.light?.primary === "#112233ff" &&
				saved.themeCustomCss === css &&
				saved.savedCustomThemes[0]?.css === css &&
				saved.savedCustomThemes[0]?.tokens?.light?.primary === "#112233ff" &&
				saved.themeCustomConversion?.current.length === 0 &&
				saved.themeCustomConversion?.savedThemes.length === 0,
			"token-only save lost CSS or did not persist the Host token update",
		);
	} finally {
		await pilo.shutdown();
	}
	await expectError(
		pilo.loadThemeSettings(),
		"Pilo runtime has been shut down",
	);
	await expectError(
		pilo.saveThemeSettings({ theme: "light" }),
		"Pilo runtime has been shut down",
	);

	const reopened = new Pilo(fixture.dataDir());
	try {
		assert(
			JSON.stringify(await reopened.loadThemeSettings()) ===
				JSON.stringify(saved),
			"Host theme settings did not persist",
		);
	} finally {
		await reopened.shutdown();
	}
	status.set("Host theme settings converted, validated, and persisted");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
