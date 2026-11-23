import { signal } from "nsh";
import { expect, test } from "nsh/test";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { PiCommand } from "@shared/api/pi-runtime-types";
import type { AppState } from "../state/app-state";
import { createAppState } from "../state/app-state";
import type { ModelCatalogState } from "../state/model-catalog";
import type {
	ComposerClient,
	ComposerNotice,
	ComposerTarget,
	ComposerTranscript,
} from "../composer/composer-store";
import { ComposerStore } from "../composer/composer-store";
import { scriptedClient } from "./scripted-app-client";

type Sent = { command: Record<string, unknown>; sessionKey: string };

function fakeClient(overrides: Partial<ComposerClient> = {}) {
	const sent: Sent[] = [];
	const started: Record<string, unknown>[] = [];
	const { client: runtime } = scriptedClient({
		onCommand: () => ({ success: true }),
	});
	const client: ComposerClient = {
		startChat: (options) => {
			started.push(options);
			return runtime.startChat(options);
		},
		chatState: async () => null,
		sendChatCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			return runtime.sendChatCommand(sessionKey, command);
		},
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => ["src/a.ts", "src/b.ts"],
		uploadChatFile: async (_projectId: string, name: string) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
		...overrides,
	};
	return { client, sent, started };
}

function chatState(sessionKey: string, activeTurn = false) {
	return {
		sessionKey,
		projectId: "p1",
		prepared: true,
		initialized: true,
		activeTurn: activeTurn ? { id: "t1" } : null,
	} as unknown as ChatSessionRuntimeState;
}

function storeFor(
	client: ComposerClient,
	...sessions: ChatSessionRuntimeState[]
) {
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: sessions,
	} as AppState;
	const store = new ComposerStore({ client, app: () => app });
	return { store, app };
}

const targetA: ComposerTarget = { sessionKey: "sa", projectId: "p1" };
const targetB: ComposerTarget = { sessionKey: "sb", projectId: "p1" };

test("draft text is shared within a project and isolated between projects", () => {
	const { client } = fakeClient();
	const { store } = storeFor(client);
	const otherProject = { sessionKey: "sc", projectId: "p2" };
	store.setTarget(targetA);
	store.setValue("first draft");
	store.setTarget(targetB);
	expect(store.state().value).toBe("first draft");
	store.setValue("edited draft");
	store.setTarget(otherProject);
	expect(store.state().value).toBe("");
	store.setValue("other project");
	store.setTarget(null);
	store.setTarget(targetA);
	expect(store.state().value).toBe("edited draft");
	store.setTarget(otherProject);
	expect(store.state().value).toBe("other project");
});

test("submit prompts an idle chat and clears the draft", async () => {
	const { client, sent, started } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	store.setValue("do the thing");
	await store.submit();
	expect(started).toEqual([{ projectId: "p1", sessionKey: "sa" }]);
	expect(sent.length).toBe(1);
	expect(sent[0]?.sessionKey).toBe("sa");
	const { id, ...command } = sent[0]!.command;
	expect(typeof id).toBe("string");
	expect(command).toEqual({ type: "prompt", message: "do the thing" });
	expect(store.state().value).toBe("");
	store.setTarget(targetB);
	expect(store.state().value).toBe("");
});

test("submit does not start a chat that already ran", async () => {
	const { client, sent, started } = fakeClient({
		chatState: async () => chatState("sa") as never,
	});
	const { store } = storeFor(client, chatState("sa"));
	store.setTarget(targetA);
	store.setValue("next");
	await store.submit();
	expect(started.length).toBe(0);
	expect(sent[0]?.command.type).toBe("prompt");
});

test("running turns steer, follow up or interrupt per send mode", async () => {
	const { client, sent } = fakeClient();
	const { store } = storeFor(client, chatState("sa", true));
	store.setTarget(targetA);

	store.setValue("adjust");
	await store.submit();
	expect(sent.at(-1)?.command.type).toBe("steer");

	store.setSendMode("follow_up");
	store.setValue("after");
	await store.submit();
	expect(sent.at(-1)?.command.type).toBe("follow_up");

	store.setSendMode("send_now");
	store.setValue("instead");
	await store.submit();
	expect(sent.at(-2)?.command.type).toBe("abort");
	expect(sent.at(-1)?.command.type).toBe("prompt");
});

test("stop aborts the running turn", async () => {
	const { client, sent } = fakeClient();
	const { store } = storeFor(client, chatState("sa", true));
	store.setTarget(targetA);
	await store.stop();
	expect(sent).toEqual([{ sessionKey: "sa", command: { type: "abort" } }]);
});

test("ArrowUp recalls the project's earlier prompts", async () => {
	const { client } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	store.setValue("first");
	await store.submit();
	store.setValue("second");
	await store.submit();
	expect((await store.navigateHistory("older")).handled).toBe(true);
	expect(store.state().value).toBe("second");
	expect((await store.navigateHistory("older")).handled).toBe(true);
	expect(store.state().value).toBe("first");
	expect((await store.navigateHistory("newer")).handled).toBe(true);
	expect(store.state().value).toBe("second");
});

test("switching before dispatch restores the project draft without losing newer edits", async () => {
	const { client, sent } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	store.setValue("unsent text");
	await store.addFiles([
		new File([new Uint8Array([0x89, 0x50])], "shot.png", { type: "image/png" }),
	]);

	const sending = store.submit();
	store.setTarget(targetB);
	store.setValue("new text");
	await sending;

	expect(sent).toHaveLength(0);
	expect(store.state().value).toBe("unsent text\n\nnew text");
	expect(store.state().images.map(({ name }) => name)).toEqual(["shot.png"]);
});

test("picked files upload as mentions; removing them unregisters", async () => {
	const removed: string[] = [];
	const { client } = fakeClient({
		removeChatFile: async (_p: string, path: string) => {
			removed.push(path);
		},
	});
	const { store } = storeFor(client);
	store.setTarget(targetA);
	const file = new File([new Uint8Array([1, 2, 3])], "note.md", {
		type: "text/markdown",
	});
	await store.addFiles([file]);
	const draft = store.state().value;
	expect(draft).toContain("note.md");
	store.setValue("");
	expect(removed.length).toBe(1);
});

test("image attachments are shared within a project but not across projects", async () => {
	const { client } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	const png = new File([new Uint8Array([0x89, 0x50])], "shot.png", {
		type: "image/png",
	});
	await store.addFiles([png]);
	expect(store.state().images).toHaveLength(1);
	expect(store.state().value).toBe("");
	store.setTarget({ sessionKey: "sc", projectId: "p2" });
	expect(store.state().images).toHaveLength(0);
	store.setTarget(targetB);
	expect(store.state().images.map(({ name }) => name)).toEqual(["shot.png"]);
	store.removeImage(store.state().images[0]!.id);
	store.setTarget(targetA);
	expect(store.state().images).toHaveLength(0);
});

function piCommand(
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

function catalogStub(commands: PiCommand[] | null, loaded = true) {
	let refreshed = 0;
	const state = signal<ModelCatalogState | null>({
		projectId: "p1",
		catalog:
			commands === null
				? null
				: {
						projectId: "p1",
						models: [],
						commands,
						defaultModel: null,
						defaultThinkingLevel: null,
						refreshedAtMs: 1,
					},
		scope: null,
		loaded,
		refreshing: false,
		savingScope: false,
		error: null,
	});
	return {
		catalog: {
			state,
			refresh: async () => {
				refreshed += 1;
			},
		},
		state,
		refreshes: () => refreshed,
	};
}

test("commands read from project catalog without starting Pi, then merge live extension commands once running", async () => {
	let initialized = false;
	const { client, sent, started } = fakeClient({
		chatState: async () =>
			initialized
				? ({
						...chatState("sa"),
						snapshot: { state: "running" },
					} as never)
				: null,
	});
	const { client: liveRuntime } = scriptedClient({
		onCommand: (_sessionKey, command) => {
			if (command.type === "get_commands") {
				return {
					data: {
						commands: [
							piCommand("skill:review", "skill", "Review diff"),
							piCommand("deploy", "extension", "Deploy service"),
							piCommand("llama", "extension", "TUI only"),
						],
					},
				};
			}
			return { success: true };
		},
	});
	const mergedClient: ComposerClient = {
		...client,
		sendChatCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			return liveRuntime.sendChatCommand(sessionKey, command);
		},
		connectEvents: liveRuntime.connectEvents,
	};
	const { catalog } = catalogStub([
		piCommand("skill:review", "skill", "Review diff"),
		piCommand("plan", "prompt"),
		piCommand("new", "extension"),
	]);
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
	} as AppState;
	const store = new ComposerStore({
		client: mergedClient,
		app: () => app,
		catalog,
	});
	store.setTarget(targetA);

	// Catalog commands are immediately available without starting Pi.
	expect(store.commands()).toEqual([
		{
			kind: "command",
			value: "/skill:review",
			label: "/skill:review",
			detail: "Review diff",
			skill: true,
		},
		{
			kind: "command",
			value: "/plan",
			label: "/plan",
			detail: "prompt · project",
			skill: false,
		},
	]);

	await store.loadCommands();
	expect(started).toHaveLength(0);
	expect(sent).toHaveLength(0);

	// Once Pi is running, loadCommands merges extension commands and filters reserved ones.
	initialized = true;
	await store.loadCommands();
	expect(sent.map((entry) => entry.command.type)).toEqual(["get_commands"]);
	expect(store.commands().map((item) => item.value)).toEqual([
		"/skill:review",
		"/plan",
		"/deploy",
	]);
});

test("loadCommands triggers catalog refresh when cached commands are missing", async () => {
	const { client } = fakeClient();
	const { catalog, refreshes } = catalogStub(null, true);
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
	} as AppState;
	const store = new ComposerStore({ client, app: () => app, catalog });
	store.setTarget(targetA);

	await store.loadCommands();
	expect(refreshes()).toBe(1);
});

test("submitting /new consumes the command but keeps images for the new chat", async () => {
	const { client, sent, started } = fakeClient();
	let created = 0;
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
	} as AppState;
	const store = new ComposerStore({
		client,
		app: () => app,
		onNewChat: () => {
			created += 1;
		},
	});
	store.setTarget(targetA);
	await store.addFiles([
		new File([new Uint8Array([0x89, 0x50])], "shot.png", { type: "image/png" }),
	]);
	store.setValue("/new");

	await store.submit();
	expect(created).toBe(1);
	expect(started).toHaveLength(0);
	expect(sent).toHaveLength(0);
	store.setTarget(targetB);
	expect(store.state().value).toBe("");
	expect(store.state().images.map(({ name }) => name)).toEqual(["shot.png"]);
});

test("submitting /compact compacts an idle session and blocks while running", async () => {
	const sent: Sent[] = [];
	const notices: ComposerNotice[] = [];
	let compactedCount = 0;
	let localSubmitted = 0;
	const { client: runtime } = scriptedClient({
		onCommand: (_sessionKey, command) => {
			if (command.type === "compact") {
				return {
					data: {
						summary: "done",
						firstKeptEntryId: "e1",
						tokensBefore: 12000,
						estimatedTokensAfter: 3000,
					},
				};
			}
			return { success: true };
		},
	});
	const client: ComposerClient = {
		startChat: (options) => runtime.startChat(options),
		chatState: async () => null,
		sendChatCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			return runtime.sendChatCommand(sessionKey, command);
		},
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p, name) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
	};
	const appSignal = signal<AppState>({
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: [],
	} as unknown as AppState);
	const transcript: ComposerTranscript = {
		submitLocal: () => {
			localSubmitted += 1;
			return "local-1";
		},
		setLocalStatus: () => {},
		dropLocal: () => {},
	};
	const store = new ComposerStore({
		client,
		app: appSignal,
		transcript,
		onCompacted: () => {
			compactedCount += 1;
		},
		onNotice: (notice) => notices.push(notice),
	});
	store.setTarget(targetA);
	store.setValue("/compact focus on tests");

	await store.submit();
	expect(localSubmitted).toBe(0);
	expect(compactedCount).toBe(1);
	expect(sent[0]?.command.type).toBe("compact");
	expect(sent[0]?.command.customInstructions).toBe("focus on tests");
	expect(notices.at(-1)?.variant).toBe("success");
	expect(store.state().value).toBe("");

	// While running, /compact is rejected without sending.
	appSignal.set({
		...appSignal(),
		chatSessions: [chatState("sa", true)],
	} as AppState);
	store.setValue("/compact");
	await store.submit();
	expect(sent).toHaveLength(1);
	expect(notices.at(-1)?.variant).toBe("info");
	expect(store.state().value).toBe("/compact");
});

test("cold-start extension command is detected after startChat and skips local bubble", async () => {
	const sent: Sent[] = [];
	let localSubmitted = 0;
	let promptStarted = 0;
	const { client: runtime } = scriptedClient({
		onCommand: (_sessionKey, command) => {
			if (command.type === "get_commands") {
				return {
					data: {
						commands: [piCommand("deploy", "extension", "Deploy app")],
					},
				};
			}
			return { success: true };
		},
	});
	const client: ComposerClient = {
		startChat: (options) => runtime.startChat(options),
		chatState: async () => null,
		sendChatCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			return runtime.sendChatCommand(sessionKey, command);
		},
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p, name) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
	};
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
	} as AppState;
	const transcript: ComposerTranscript = {
		submitLocal: () => {
			localSubmitted += 1;
			return "local-1";
		},
		setLocalStatus: () => {},
		dropLocal: () => {},
	};
	const store = new ComposerStore({
		client,
		app: () => app,
		transcript,
		onPromptStarted: () => {
			promptStarted += 1;
		},
	});
	store.setTarget(targetA);
	store.setValue("/deploy prod");

	await store.submit();
	expect(localSubmitted).toBe(0);
	expect(promptStarted).toBe(0);
	expect(sent.map((entry) => entry.command.type)).toEqual([
		"get_commands",
		"prompt",
	]);
	expect(sent[1]?.command).toEqual({ type: "prompt", message: "/deploy prod" });
	expect(store.state().value).toBe("");
	expect(store.commands().map((item) => item.value)).toEqual(["/deploy"]);
});

test("sessionMentions and sessionsByValue stay referentially stable across navigation changes", () => {
	const { client } = fakeClient();
	const projects = [{ id: "p1", name: "Project" }] as AppState["projects"];
	const sessionIndexes = {
		p1: {
			status: "loaded" as const,
			sessions: [
				{
					connectionId: "local",
					projectId: "p1",
					piSessionId: "s1",
					sessionPath: "/sessions/s1.jsonl",
					name: "First",
					cwd: "/project",
					createdAt: "2026-11-20T00:00:00Z",
					updatedAt: "2026-11-20T00:00:00Z",
					messageCount: 2,
					lastMessageAt: "2026-11-20T00:00:00Z",
					firstUserMessagePreview: "First",
					fileSize: 10,
					fileMtimeNs: "100",
					lastOffset: 10,
					indexedAtMs: 0,
					pinned: false,
					titleOverride: null,
				},
			],
		},
	};
	const app = signal<AppState>({
		...createAppState(),
		projects,
		sessionIndexes,
		navigation: {
			projectId: "p1",
			session: { projectId: "p1", sessionPath: "/sessions/s1.jsonl" },
		},
	});
	const store = new ComposerStore({ client, app });
	const mentionsBefore = store.sessionMentions();
	const mapBefore = store.sessionsByValue();

	app.set({
		...app(),
		navigation: {
			projectId: "p1",
			session: { projectId: "p1", sessionPath: "/sessions/s2.jsonl" },
		},
	});

	expect(store.sessionMentions()).toBe(mentionsBefore);
	expect(store.sessionsByValue()).toBe(mapBefore);
});
