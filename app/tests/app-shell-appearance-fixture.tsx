import { mount, Storage, Text, token, View } from "nsh";
import { Button } from "nsh/base";

import type { AppLocale } from "@shared/i18n/locale-types";
import type { HostPreferenceValues } from "@shared/host-preferences-types";
import type { ThemeSettings } from "@shared/theme-settings-types";
import { AppShell } from "../shell/AppShell";
import { ComposerStore } from "../composer/composer-store";
import { conversationContext } from "../shell/open-chat";
import { initializeI18n } from "../shell/i18n";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { composerStubClient } from "./composer-fixture";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

/**
 * The shell over a runtime whose saved language, fonts and theme the test
 * gives with `open`'s `storage` (`fixture.locale`, and `fixture.fonts` and
 * `fixture.theme` as JSON), and changes afterwards with the buttons under the
 * shell. The line under the buttons names the fonts the theme now holds, as
 * nsh reads them: the first family of each, `system` for the system's own.
 */
const theme = (revision: number, settings: Partial<ThemeSettings>) =>
	({ revision, ...settings }) as ThemeSettings;

async function stored(key: string) {
	return JSON.parse((await Storage.getItem(key)) ?? "{}");
}

async function run() {
	let values: HostPreferenceValues = {
		...HOST_DEFAULT_VALUES,
		...(await stored("fixture.fonts")),
		locale: (await Storage.getItem("fixture.locale")) as AppLocale,
	};
	const runtime = scriptedClient({
		preferences: { revision: 1, values },
		themeSettings: theme(1, await stored("fixture.theme")),
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	let revision = 1;
	const preferenceChange = (
		label: string,
		patch: Partial<HostPreferenceValues>,
	) => (
		<Button
			onPress={() => {
				values = { ...values, ...patch };
				runtime.emit({
					type: "preferences_changed",
					settings: { revision: ++revision, values },
				});
			}}
		>
			<Text>{label}</Text>
		</Button>
	);
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
			<AppShell store={store} chat={chat} composer={composer} />
			<View class="flex-row flex-wrap gap-2">
				{preferenceChange("Save English", { locale: "en-US" })}
				{preferenceChange("Save Georgia and Menlo", {
					pageFontFamily: "Georgia",
					codeFontFamily: "Menlo",
					codeFontSize: 16,
				})}
				{preferenceChange("Save system fonts", {
					pageFontFamily: "system-sans",
					codeFontFamily: "system-mono",
				})}
				{themeChange("Save Lody light", {
					theme: "light",
					themeFamily: "lody",
				})}
				{themeChange("Save Claude system", {
					theme: "system",
					themeFamily: "claude",
				})}
				{themeChange("Save Grove system", {
					theme: "system",
					themeFamily: "grove",
				})}
				{themeChange("Save Ocean dark", {
					theme: "dark",
					themeFamily: "ocean",
				})}
				{themeChange("Save Ember light", {
					theme: "light",
					themeFamily: "ember",
				})}
				{themeChange("Save Iris dark", {
					theme: "dark",
					themeFamily: "iris",
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
				{themeChange("Save custom fonts", {
					theme: "light",
					themeFamily: "custom",
					themeCustomTokens: {
						theme: {
							"font-sans": "Courier New",
							"font-mono": "Courier New",
							"font-display": "Times New Roman",
							"pilo-code-font-size": "20px",
						},
					},
				})}
			</View>
			<Text testID="fonts">
				{() =>
					[
						`page ${token("font-sans") ?? "system"}`,
						`code ${token("font-mono")} ${token("pilo-code-font-size")}`,
						`display ${token("font-display") ?? "system"}`,
					].join(", ")
				}
			</Text>
			<Text testID="geometry">
				{() =>
					[
						`sidebar ${token("pilo-sidebar-radius")}`,
						`composer ${token("pilo-composer-radius")}`,
						`md ${token("pilo-radius-md")}`,
						`mobileRing ${token("pilo-mobile-selected-ring-width")}`,
					].join(", ")
				}
			</Text>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();
