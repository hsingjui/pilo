import { cleanup, Text, View, signal } from "nsh";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { PiCommand } from "@shared/api/pi-runtime-types";
import type { ComposerClient } from "../composer/composer-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatComposer } from "../composer/chat-composer";
import { initializeI18n } from "../shell/i18n";
import { createAppState, type AppState } from "../state/app-state";
import type { ModelCatalogState } from "../state/model-catalog";
import { scriptedClient } from "./scripted-app-client";

/** Reports each command the composer sends, as a status line for the test. */
const activity = signal("idle");
/** Reports the latest prompt/steer message payload sent by the composer. */
const lastMessage = signal("");
/** Counts synthetic live-turn updates emitted while `fixture.pulseStream` is on. */
const streamTick = signal(0);

function fixtureCommand(
	name: string,
	source: PiCommand["source"],
	description?: string,
): PiCommand {
	return {
		name,
		description,
		source,
		sourceInfo: {
			path: `/pi/${name}`,
			source,
			scope: "project",
			origin: "top-level",
		},
	};
}

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
	activity.set("idle");
	lastMessage.set("");
	streamTick.set(0);
	const { client: runtime } = scriptedClient({
		onCommand: (_sessionKey, command) => {
			if (command.type === "get_commands") {
				return {
					data: {
						commands: [
							fixtureCommand("deploy", "extension", "Deploy build"),
							fixtureCommand("llama", "extension", "TUI only"),
						],
					},
				};
			}
			return { success: true };
		},
	});
	const client: ComposerClient = {
		startChat: (options) => {
			activity.set("started");
			return runtime.startChat(options);
		},
		chatState: async () =>
			activeTurn
				? ({
						sessionKey: "sa",
						projectId: "p1",
						prepared: true,
						initialized: true,
						snapshot: { state: "running" },
						activeTurn: { id: "t1" },
					} as unknown as ChatSessionRuntimeState)
				: null,
		sendChatCommand: (sessionKey, command) => {
			activity.set(`sent:${String(command.type ?? "?")}`);
			if (typeof command.message === "string") {
				lastMessage.set(command.message);
			}
			return runtime.sendChatCommand(sessionKey, command);
		},
		connectEvents: runtime.connectEvents,
		// "@fail" stands for a search the Host could not run.
		searchProjectFiles: async (_p: string, query: string) => {
			if (query === "fail") throw new Error("search failed");
			return [
				"src/chat-user-message-body.tsx",
				"desktop/.nsh/rust/description.json",
				"docs/unknown.xyz",
			];
		},
		uploadChatFile: async (_p: string, name: string) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
	};

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
	const pulseTimers: ReturnType<typeof setTimeout>[] = [];
	cleanup(() => {
		for (const timer of pulseTimers) clearTimeout(timer);
		pulseTimers.length = 0;
	});
	const scheduleStreamPulse = () => {
		for (const delay of [120, 160, 200]) {
			pulseTimers.push(
				setTimeout(() => {
					appSignal.update((current) => ({
						...current,
						chatSessions: current.chatSessions.map((session) => ({
							...session,
						})),
					}));
					streamTick.update((count) => count + 1);
				}, delay),
			);
		}
	};
	const catalogState = signal<ModelCatalogState | null>({
		projectId: "p1",
		catalog: {
			projectId: "p1",
			models: [],
			commands: [
				fixtureCommand("skill:review", "skill", "Review changes"),
				fixtureCommand("plan", "prompt"),
			],
			defaultModel: null,
			defaultThinkingLevel: null,
			refreshedAtMs: 1,
		},
		scope: null,
		loaded: true,
		refreshing: false,
		savingScope: false,
		error: null,
	});
	const store = new ComposerStore({
		client,
		app: appSignal,
		catalog: {
			state: catalogState,
			refresh: async () => {},
		},
		onNewChat: () => {
			activity.set("new-chat");
		},
	});
	store.setTarget({ sessionKey: "sa", projectId: "p1" });
	return { store, scheduleStreamPulse };
}

const SAMPLE_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
	0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
	0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
	0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
	0x60, 0x82,
]);

export function composerFixtureRoot(activeTurn = false) {
	initializeI18n("en-US");
	const { store, scheduleStreamPulse } = composerFixture(activeTurn);
	return (
		<View class="bg-background" style={{ width: "100%", gap: 8 }}>
			<ChatComposer store={store} />
			<View testID="fixture-pulse-stream" onPress={() => scheduleStreamPulse()}>
				<Text>pulse-stream</Text>
			</View>
			<View
				testID="fixture-attach-image"
				onPress={() => {
					void store.addFiles([
						new File([SAMPLE_PNG], "shot.png", { type: "image/png" }),
					]);
				}}
			>
				<Text>attach-image</Text>
			</View>
			<View
				testID="fixture-attach-second-image"
				onPress={() => {
					void store.addFiles([
						new File([SAMPLE_PNG], "shot-2.png", { type: "image/png" }),
					]);
				}}
			>
				<Text>attach-second-image</Text>
			</View>
			<View
				testID="fixture-switch-chat"
				onPress={() => {
					store.setTarget({
						projectId: "p1",
						sessionKey: store.target()?.sessionKey === "sa" ? "sb" : "sa",
					});
				}}
			>
				<Text>switch-chat</Text>
			</View>
			<Text testID="composer-activity">{activity}</Text>
			<Text testID="composer-stream-tick">{() => `tick:${streamTick()}`}</Text>
			<View testID="composer-last-message">
				<Text>{lastMessage}</Text>
			</View>
		</View>
	);
}
