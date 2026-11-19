import { mount, Storage } from "nsh";

import type { Project } from "@/lib/api/projects-types";
import type { PreferencesSnapshot } from "@/lib/host-preferences-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { AppShell } from "../app/AppShell";
import { initializeI18n } from "../app/i18n";
import { AppStore, type AppStoreClient } from "../state/app-store";
import { applyFixtureTheme } from "./app-shell-theme";

/**
 * The shell over a scripted client, for the startups the native runtime does
 * not produce on demand. The test names one with `open`'s `storage`:
 * `starting` never answers, `failed` fails its first two tries, `empty` has
 * no project and `closed` loads, then loses its runtime.
 */
type Scenario = "starting" | "failed" | "empty" | "closed";

const failures = ["The Pilo database is locked.", "The Pi runtime is missing."];

const project = {
	id: "p1",
	name: "pilo",
	path: "/Users/pilo/code/pilo",
} as Project;

function scriptedClient(scenario: Scenario): AppStoreClient {
	let bootstraps = 0;
	let closed = false;
	return {
		get closed() {
			return closed;
		},
		bootstrap() {
			bootstraps += 1;
			if (scenario === "starting") return new Promise(() => {});
			const failure = scenario === "failed" && failures[bootstraps - 1];
			if (failure) return Promise.reject(new Error(failure));
			return Promise.resolve({
				projects: scenario === "empty" ? [] : [project],
				chatSessions: [],
				latestSequence: 0,
				preferences: { revision: 0 } as unknown as PreferencesSnapshot,
			});
		},
		listProjects: () => Promise.resolve([project]),
		listSessions: () => Promise.resolve([]),
		loadSessionReadStates: () => Promise.resolve([]),
		loadThemeSettings: () => Promise.resolve({ revision: 0 } as ThemeSettings),
		markSessionRead: () => Promise.reject(new Error("no session to mark")),
		connectEvents(options) {
			options.onStatus(true);
			if (scenario === "closed") {
				setTimeout(() => {
					closed = true;
					options.onStatus(false);
				}, 50);
			}
			return Promise.resolve(() => {});
		},
	};
}

async function run() {
	const scenario = (await Storage.getItem("fixture.scenario")) as Scenario;
	await applyFixtureTheme();
	const store = new AppStore(scriptedClient(scenario));
	mount(AppShell, { store });
	await store.start();
}

initializeI18n();
void run();
