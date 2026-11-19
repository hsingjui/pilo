import { mount, Storage, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { AppLocale } from "@/i18n/locale-types";
import type { PreferencesSnapshot } from "@/lib/host-preferences-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { AppShell } from "../app/AppShell";
import { initializeI18n } from "../app/i18n";
import { AppStore } from "../state/app-store";
import { scriptedClient } from "./scripted-app-client";

/**
 * The shell over a runtime whose saved language and theme the test gives
 * with `open`'s `storage` (`fixture.locale`, `fixture.theme` as JSON), and
 * changes afterwards with the buttons under the shell.
 */
const preferences = (revision: number, locale: AppLocale) =>
	({ revision, values: { locale } }) as PreferencesSnapshot;
const theme = (revision: number, settings: Partial<ThemeSettings>) =>
	({ revision, ...settings }) as ThemeSettings;

async function run() {
	const locale = (await Storage.getItem("fixture.locale")) as AppLocale;
	const saved = JSON.parse((await Storage.getItem("fixture.theme")) ?? "{}");
	const runtime = scriptedClient({
		preferences: preferences(1, locale),
		themeSettings: theme(1, saved),
	});
	const store = new AppStore(runtime.client);
	let revision = 1;
	const themeChange = (label: string, settings: Partial<ThemeSettings>) => (
		<Button
			onPress={() =>
				runtime.emit({
					type: "theme_settings_changed",
					settings: theme(++revision, settings),
				})
			}
		>
			<Text>{label}</Text>
		</Button>
	);
	mount(() => (
		<View class="flex-1">
			<AppShell store={store} />
			<View class="flex-row gap-2">
				<Button
					onPress={() =>
						runtime.emit({
							type: "preferences_changed",
							settings: preferences(++revision, "en-US"),
						})
					}
				>
					<Text>Save English</Text>
				</Button>
				{themeChange("Save Lody light", {
					theme: "light",
					themeFamily: "lody",
				})}
				{themeChange("Save Claude system", {
					theme: "system",
					themeFamily: "claude",
				})}
				{themeChange("Save custom", {
					theme: "light",
					themeFamily: "custom",
					themeCustomTokens: { light: { background: "#102030" } },
				})}
				{themeChange("Save invalid custom", {
					theme: "light",
					themeFamily: "custom",
					themeCustomTokens: { light: { background: "not a color" } },
				})}
			</View>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();
