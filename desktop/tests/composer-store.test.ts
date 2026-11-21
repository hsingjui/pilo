import { expect, test } from "nsh/test";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { AppState } from "../state/app-state";
import { createAppState } from "../state/app-state";
import type {
	ComposerClient,
	ComposerTarget,
} from "../composer/composer-store";
import { ComposerStore } from "../composer/composer-store";

type Sent = { command: Record<string, unknown>; sessionKey: string };

function fakeClient(overrides: Partial<ComposerClient> = {}) {
	const sent: Sent[] = [];
	const started: Record<string, unknown>[] = [];
	const client = {
		startChat: async (options: Record<string, unknown>) => {
			started.push(options);
			return { state: "running", generation: 1 } as never;
		},
		chatState: async () => null,
		sendChatCommand: async (sessionKey: string, command: object) => {
			sent.push({ sessionKey, command: command as Record<string, unknown> });
		},
		connectEvents: async () => () => {},
		searchProjectFiles: async () => ["src/a.ts", "src/b.ts"],
		uploadChatFile: async (_projectId: string, name: string) =>
			`/attachments/abcdefghijklmnopqrstuA/${name}`,
		removeChatFile: async () => {},
		...overrides,
	} as unknown as ComposerClient;
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

test("drafts stay with their session", () => {
	const { client } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	store.setValue("hello a");
	store.setTarget(targetB);
	expect(store.state().value).toBe("");
	store.setValue("hello b");
	store.setTarget(targetA);
	expect(store.state().value).toBe("hello a");
});

test("submit prompts an idle chat and clears the draft", async () => {
	const { client, sent, started } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	store.setValue("do the thing");
	await store.submit();
	expect(started).toEqual([{ projectId: "p1", sessionKey: "sa" }]);
	expect(sent).toEqual([
		{
			sessionKey: "sa",
			command: { type: "prompt", message: "do the thing" },
		},
	]);
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

test("image files attach as image content, not mentions", async () => {
	const { client } = fakeClient();
	const { store } = storeFor(client);
	store.setTarget(targetA);
	const png = new File([new Uint8Array([0x89, 0x50])], "shot.png", {
		type: "image/png",
	});
	await store.addFiles([png]);
	expect(store.state().images.length).toBe(1);
	expect(store.state().value).toBe("");
	store.removeImage(store.state().images[0]!.id);
	expect(store.state().images.length).toBe(0);
});
