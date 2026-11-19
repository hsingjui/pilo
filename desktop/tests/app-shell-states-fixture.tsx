import { mount, Storage } from "nsh";

import type { Project } from "@/lib/api/projects-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { AppShell } from "../app/AppShell";
import { conversationContext } from "../app/open-chat";
import { initializeI18n } from "../app/i18n";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { fixtureThemeFamily } from "./fixture-theme";
import { type AppScript, scriptedClient } from "./scripted-app-client";

/**
 * The shell over a scripted client, for the startups the native runtime does
 * not produce on demand, in the theme the test saved. The test names one with
 * `open`'s `storage`:
 * `starting` never answers, `failed` fails its first two tries, `empty` has
 * no project and `closed` loads, then loses its runtime.
 */
type Scenario = "starting" | "failed" | "empty" | "closed";

const failures = ["The Pilo database is locked.", "The Pi runtime is missing."];
const project = {
	id: "p1",
	name: "pilo",
	path: "/Users/pilo/code/pilo",
	connection: { id: "local", name: "Local", kind: { type: "local" } },
} as Project;

const scripts: Record<Scenario, AppScript> = {
	starting: { bootstrap: () => new Promise(() => {}) },
	failed: {
		projects: [project],
		bootstrap(attempt) {
			const failure = failures[attempt - 1];
			return failure ? Promise.reject(new Error(failure)) : undefined;
		},
	},
	empty: {},
	closed: { projects: [project] },
};

async function run() {
	const scenario = (await Storage.getItem("fixture.scenario")) as Scenario;
	const themeSettings = {
		revision: 1,
		theme: "system",
		themeFamily: await fixtureThemeFamily(),
	} as ThemeSettings;
	const runtime = scriptedClient({ ...scripts[scenario], themeSettings });
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	mount(AppShell, { store, chat });
	await store.start();
	if (scenario === "closed") setTimeout(runtime.close, 50);
}

initializeI18n();
void run();
