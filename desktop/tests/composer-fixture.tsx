import { mount, Text, View, signal } from "nsh";
import "../app/fonts";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { ComposerClient } from "../composer/composer-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatComposer } from "../composer/chat-composer";
import { initializeI18n } from "../app/i18n";
import { createAppState, type AppState } from "../state/app-state";

/** Reports each command the composer sends, as a status line for the test. */
const activity = signal("idle");

/** A client whose composer-only methods are stubs, for shell fixtures. */
export function composerStubClient(client: object): ComposerClient {
	return {
		...client,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p: string, name: string) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
	} as unknown as ComposerClient;
}

function composerFixture(activeTurn: boolean) {
	const client = {
		startChat: async (_options: Record<string, unknown>) => {
			activity.set("started");
			return { state: "running", generation: 1 };
		},
		chatState: async () => null,
		sendChatCommand: async (_sessionKey: string, command: object) => {
			activity.set(`sent:${(command as { type?: string }).type ?? "?"}`);
		},
		connectEvents: async () => () => {},
		// "@fail" stands for a search the Host could not run.
		searchProjectFiles: async (_p: string, query: string) => {
			if (query === "fail") throw new Error("search failed");
			return ["src/a.ts"];
		},
		uploadChatFile: async (_p: string, name: string) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
	} as unknown as ComposerClient;

	const chat = {
		sessionKey: "sa",
		projectId: "p1",
		prepared: true,
		initialized: true,
		activeTurn: activeTurn ? { id: "t1" } : null,
	} as unknown as ChatSessionRuntimeState;
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: [chat],
		// One earlier session for the `@` menu's session tab.
		sessionIndexes: {
			p1: {
				sessions: [
					{
						projectId: "p1",
						connectionId: "local",
						sessionPath: "/sessions/earlier.jsonl",
						name: "Earlier chat",
						updatedAt: "2026-11-01T00:00:00Z",
					},
				],
			},
		},
	} as unknown as AppState;
	const appSignal = signal(app);
	const store = new ComposerStore({ client, app: appSignal });
	store.setTarget({ sessionKey: "sa", projectId: "p1" });
	return store;
}

export function composerFixtureRoot(activeTurn = false) {
	initializeI18n("en-US");
	const store = composerFixture(activeTurn);
	return (
		<View class="bg-background" style={{ width: 420 }}>
			<ChatComposer store={store} />
			<Text testID="composer-activity">{activity}</Text>
		</View>
	);
}
