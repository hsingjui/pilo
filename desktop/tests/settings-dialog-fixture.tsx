import { mount, setTheme, Text, View } from "nsh";

import type { Connection } from "@/lib/api/pi-runtime-types";
import type { Project } from "@/lib/api/projects-types";
import type { PreferencesSnapshot } from "@/lib/host-preferences-types";
import {
	type KeyboardShortcutMap,
	SHORTCUT_COMMANDS,
} from "@/lib/keyboard-shortcuts-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { AppShell } from "../app/AppShell";
import { conversationContext, followOpenSession } from "../app/open-chat";
import { initializeI18n } from "../app/i18n";
import { AppStore } from "../state/app-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import claude from "../claude-theme.json";
import lody from "../theme.json";
import { composerStubClient } from "./composer-fixture";
import { fixtureThemeFamily } from "./fixture-theme";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

/**
 * The shell over a scripted client with its settings wired, for the settings
 * dialog: `settings-probe` echoes a saved preference so a test sees a write
 * land, and the theme buttons swap Lody and Claude for screenshots.
 */
const local = { id: "local", name: "Local", kind: { type: "local" } };

const project = {
	id: "pilo",
	name: "pilo",
	path: "/code/pilo",
	connection: local as Connection,
} as Project;

async function run() {
	const themeSettings = {
		revision: 1,
		theme: "system",
		themeFamily: await fixtureThemeFamily(),
	} as ThemeSettings;
	const keyboardShortcuts = Object.fromEntries(
		SHORTCUT_COMMANDS.map((command) => [command.id, command.defaultShortcut]),
	) as KeyboardShortcutMap;
	const preferences = {
		revision: 1,
		values: {
			...HOST_DEFAULT_VALUES,
			keyboardShortcuts,
		},
	} as PreferencesSnapshot;
	const runtime = scriptedClient({
		projects: [project],
		preferences,
		themeSettings,
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	followOpenSession(store, chat);
	mount(() => (
		<View class="flex-1 bg-background">
			<AppShell
				store={store}
				chat={chat}
				composer={composer}
				searchSessions={runtime.client}
				settings={runtime.client}
			/>
			<View class="absolute bottom-2 right-2 flex-row items-center gap-2">
				<Text testID="settings-probe">
					{() =>
						String(
							store.state().preferences?.values.collapseLongMessages ?? "unset",
						)
					}
				</Text>
				<Button
					testID="lody-theme"
					onPress={() => {
						setTheme({ cssVars: lody.cssVars });
						setStyleTheme(null);
					}}
				>
					<Text>Lody</Text>
				</Button>
				<Button
					testID="claude-theme"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude</Text>
				</Button>
			</View>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();
