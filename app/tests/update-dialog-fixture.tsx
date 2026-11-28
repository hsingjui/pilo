import { host, mount, Storage, View } from "nsh";
import type { AppUpdate, UpdateProgress } from "nsh/updater";

import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { PreferencesSnapshot } from "@shared/host-preferences-types";
import type { ThemeSettings } from "@shared/theme-settings-types";
import { ComposerStore } from "../composer/composer-store";
import { AppShell } from "../shell/AppShell";
import { createDesktopUpdate } from "../shell/desktop-update";
import { initializeI18n } from "../shell/i18n";
import { conversationContext, followOpenSession } from "../shell/open-chat";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { composerStubClient } from "./composer-fixture";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

interface FixtureParams {
	mode?:
		| "available"
		| "empty-notes"
		| "failed-notes-then-recover"
		| "download-error"
		| "manual-open"
		| "preview";
}

const local = { id: "local", name: "Local", kind: { type: "local" } };
const project = {
	id: "pilo",
	name: "pilo",
	path: "/code/pilo",
	connection: local as Connection,
} as Project;

async function run() {
	const params = (host.params as FixtureParams | undefined) ?? {};
	const mode = params.mode ?? "available";

	let resolveDownload: (() => void) | null = null;
	let rejectDownload: ((error: Error) => void) | null = null;
	let progressCb: ((progress: UpdateProgress) => void) | null = null;
	let notesAttempts = 0;
	let checkCalls = 0;
	let installCalls = 0;
	const openedUrls: string[] = [];

	const saveState = () =>
		void Storage.setItem(
			"update-fixture-state",
			JSON.stringify({ checkCalls, installCalls, notesAttempts, openedUrls }),
		);

	const updateForMode = (): AppUpdate | null => {
		if (mode === "preview") return null;
		return {
			version: "0.5.0",
			notes:
				mode === "failed-notes-then-recover"
					? "Manifest fallback summary"
					: mode === "empty-notes"
						? null
						: "Manifest note",
			url: "https://github.com/hsingjui/pilo/releases/tag/v0.5.0",
			canInstall: mode !== "manual-open",
			shell: false,
		};
	};

	const update = createDesktopUpdate({
		isDev: mode === "preview",
		autoCheck: mode !== "preview",
		updater: {
			checkForUpdate: async () => {
				checkCalls += 1;
				saveState();
				return updateForMode();
			},
			downloadUpdate: (onProgress) =>
				new Promise<void>((resolve, reject) => {
					progressCb = onProgress ?? null;
					resolveDownload = resolve;
					rejectDownload = reject;
					if (mode === "download-error") {
						reject(new Error("network connection dropped"));
					}
				}),
			installAndRestart: async () => {
				installCalls += 1;
				saveState();
			},
			openUrl: async (url) => {
				openedUrls.push(url);
				saveState();
			},
		},
		fetchReleaseNotes: async () => {
			notesAttempts += 1;
			saveState();
			if (mode === "empty-notes") return "";
			if (mode === "failed-notes-then-recover") {
				if (notesAttempts === 1) {
					throw new Error("GitHub Release: 502");
				}
				return "## Recovered notes\n\n- Retry succeeded";
			}
			return [
				"## Highlights",
				"",
				"- Added native update dialog",
				"",
				"---",
				"### 下载安装",
				"",
				"This installer footer should stay on GitHub only.",
			].join("\n");
		},
	});

	host.on("fixture", (event) => {
		if (event === "progress-40") {
			progressCb?.({ received: 4_000_000, total: 10_000_000 });
		}
		if (event === "finish-download") {
			progressCb?.({ received: 10_000_000, total: 10_000_000 });
			resolveDownload?.();
		}
		if (event === "fail-download") {
			rejectDownload?.(new Error("fetch timeout"));
		}
	});

	const runtime = scriptedClient({
		projects: [project],
		preferences: {
			revision: 1,
			values: HOST_DEFAULT_VALUES,
		} as PreferencesSnapshot,
		themeSettings: {
			revision: 1,
			theme: "system",
			themeFamily: "lody",
		} as ThemeSettings,
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
				settings={runtime.client}
				shell={runtime.shell}
				update={update}
			/>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();
