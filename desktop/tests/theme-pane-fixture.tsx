import { mount, Scroll, View } from "nsh";

import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { conversationContext } from "../app/open-chat";
import { ThemePane } from "../settings/theme-pane";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { scriptedClient } from "./scripted-app-client";

/**
 * The appearance pane alone over a scripted client whose theme settings hold
 * a token-backed saved theme ("Crimson", already applied) and a CSS-only one
 * ("Old CSS", carrying an unconverted-CSS report).
 */
const CRIMSON_TOKENS = {
	theme: { background: "#fff8f8ff" },
	dark: { background: "#1a0d0dff" },
};

const themeSettings = {
	revision: 1,
	theme: "system",
	themeFamily: "custom",
	themeCustomCss: "",
	themeCustomName: "Crimson",
	themeCustomTokens: CRIMSON_TOKENS,
	savedCustomThemes: [
		{ name: "Crimson", css: "", tokens: CRIMSON_TOKENS },
		{ name: "Old CSS", css: "@media print { .x { color: red } }" },
	],
	themeCustomConversion: {
		current: [
			{
				kind: "declaration",
				selector: ".legacy",
				text: "--bogus-token: 1px",
				reason: "unknown-token",
			},
		],
		savedThemes: [
			{
				name: "Old CSS",
				issues: [
					{
						kind: "rule",
						selector: "@media print",
						text: "@media print { .x { color: red } }",
						reason: "unsupported-at-rule",
					},
				],
			},
		],
	},
} as ThemeSettings;

async function run() {
	const runtime = scriptedClient({ themeSettings });
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	mount(() => (
		<Scroll testID="theme-pane-scroll" class="flex-1 bg-background">
			<View class="p-3">
				<ThemePane state={store.state} client={runtime.client} />
			</View>
		</Scroll>
	));
	await store.start();
}

initializeI18n();
void run();
