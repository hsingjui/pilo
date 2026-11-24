import { expect, test } from "nsh/test";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import type {
	ComposerClient,
	ComposerNotice,
	ComposerTarget,
} from "../composer/composer-store";
import { ComposerStore } from "../composer/composer-store";
import { createAppState, type AppState } from "../state/app-state";
import { ChatQueueStore } from "../state/chat-queue-store";
import { scriptedClient } from "./scripted-app-client";

type QueueRigOptions = {
	emitQueueUpdateBeforeReply?: boolean;
	promptDisposition?: "queued" | "started" | "handled";
	failOn?: string;
};

function createQueueRig(options: QueueRigOptions = {}) {
	const emitBefore = options.emitQueueUpdateBeforeReply ?? true;
	const sent: Array<{ sessionKey: string; command: Record<string, unknown> }> =
		[];
	const notices: ComposerNotice[] = [];
	const queues = new Map<string, { steering: string[]; followUp: string[] }>();
	let sequence = 1;

	const stateFor = (sessionKey: string) => {
		let state = queues.get(sessionKey);
		if (!state) {
			state = { steering: [], followUp: [] };
			queues.set(sessionKey, state);
		}
		return state;
	};

	const { client: runtime, emit } = scriptedClient({
		onCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			const type = String(command.type ?? "");
			if (options.failOn === type) {
				return { success: false, error: `${type} rejected` };
			}
			const q = stateFor(sessionKey);
			if (type === "steer" || type === "follow_up") {
				const message = String(command.message ?? "");
				if (type === "steer") q.steering.push(message);
				else q.followUp.push(message);
				if (emitBefore) {
					queue.receive({
						sequence: ++sequence,
						timestampMs: 1000,
						sessionKey,
						generation: 1,
						type: "queue_update",
						steering: [...q.steering],
						followUp: [...q.followUp],
					});
				}
				return { success: true, data: { disposition: "queued" } };
			}
			if (type === "clear_queue") {
				const cleared = {
					steering: [...q.steering],
					followUp: [...q.followUp],
				};
				q.steering = [];
				q.followUp = [];
				queue.receive({
					sequence: ++sequence,
					timestampMs: 1000,
					sessionKey,
					generation: 1,
					type: "queue_update",
					steering: [],
					followUp: [],
				});
				return { success: true, data: cleared };
			}
			if (type === "abort") {
				return { success: true };
			}
			if (type === "prompt") {
				return {
					success: true,
					data: { disposition: options.promptDisposition ?? "started" },
				};
			}
			return { success: true };
		},
	});

	const client: ComposerClient = {
		startChat: runtime.startChat,
		chatState: async (sessionKey) =>
			({
				sessionKey,
				projectId: "p1",
				prepared: true,
				initialized: true,
				activeTurn: { id: "t1" },
			}) as unknown as ChatSessionRuntimeState,
		sendChatCommand: runtime.sendChatCommand,
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p, name) => `/attachments/a/${name}`,
		removeChatFile: async () => {},
	};

	const queue = new ChatQueueStore(client);
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: [
			{
				sessionKey: "sa",
				projectId: "p1",
				prepared: true,
				initialized: true,
				activeTurn: { id: "t1" },
			} as unknown as ChatSessionRuntimeState,
		],
	} as AppState;
	const composer = new ComposerStore({
		client,
		app: () => app,
		queue,
		onNotice: (notice) => notices.push(notice),
	});
	const target: ComposerTarget = { sessionKey: "sa", projectId: "p1" };
	composer.setTarget(target);

	const pushQueueUpdate = (
		steering: string[],
		followUp: string[],
		sessionKey = "sa",
	) => {
		queue.receive({
			sequence: ++sequence,
			timestampMs: 1000,
			sessionKey,
			generation: 1,
			type: "queue_update",
			steering,
			followUp,
		});
	};

	const pushEvent = (event: PiloClientEvent) => queue.receive(event);

	return {
		queue,
		composer,
		target,
		sent,
		notices,
		emit,
		pushQueueUpdate,
		pushEvent,
	};
}

test("queues steer and follow_up messages and updates when Pi consumes them", async () => {
	const { queue, composer, pushQueueUpdate } = createQueueRig();

	composer.setValue("adjust direction");
	await composer.submit();
	composer.setValue("then summarize");
	await composer.submit("follow_up");

	const items = queue.items("sa");
	expect(items.map((item) => [item.kind, item.submission.text])).toEqual([
		["steer", "adjust direction"],
		["follow_up", "then summarize"],
	]);
	expect(queue.canMutate("sa")).toBe(true);

	// Pi consumes the steer message first.
	pushQueueUpdate([], ["then summarize"]);
	expect(queue.items("sa").map((item) => item.submission.text)).toEqual([
		"then summarize",
	]);

	// Pi consumes the remaining follow-up.
	pushQueueUpdate([], []);
	expect(queue.items("sa")).toEqual([]);
});

test("keeps queued item visible when RPC reply arrives before queue_update", async () => {
	const { queue, composer, pushQueueUpdate } = createQueueRig({
		emitQueueUpdateBeforeReply: false,
	});

	composer.setValue("early reply");
	await composer.submit();

	expect(queue.items("sa").map((item) => item.submission.text)).toEqual([
		"early reply",
	]);
	expect(queue.canMutate("sa")).toBe(true);

	// Delayed queue_update confirms, then empty update clears it.
	pushQueueUpdate(["early reply"], []);
	expect(queue.items("sa")).toHaveLength(1);
	pushQueueUpdate([], []);
	expect(queue.items("sa")).toEqual([]);
});

test("edit retrieves the chosen message without overwriting newer draft edits and replays the rest", async () => {
	const { queue, composer, sent } = createQueueRig();

	composer.setValue("first steer");
	await composer.submit();
	composer.setValue("later follow-up");
	await composer.submit("follow_up");
	composer.setValue("typing new note");

	const [first] = queue.items("sa");
	expect(first?.id).not.toBeNull();
	await queue.change(composer, first!.id!, "edit");

	expect(composer.state().value).toBe("first steer\n\ntyping new note");
	expect(
		queue.items("sa").map((item) => [item.kind, item.submission.text]),
	).toEqual([["follow_up", "later follow-up"]]);
	expect(sent.map((entry) => entry.command.type)).toEqual([
		"steer",
		"follow_up",
		"clear_queue",
		"follow_up",
	]);
});

test("send_now on a queued item clears queue, aborts, prompts immediately, and replays remaining", async () => {
	const { queue, composer, sent } = createQueueRig();

	composer.setValue("keep queued");
	await composer.submit("follow_up");
	composer.setValue("urgent now");
	await composer.submit("follow_up");

	const urgent = queue
		.items("sa")
		.find((item) => item.submission.text === "urgent now");
	await queue.change(composer, urgent!.id!, "send_now");

	expect(
		sent.map((entry) => [entry.command.type, entry.command.message ?? null]),
	).toEqual([
		["follow_up", "keep queued"],
		["follow_up", "urgent now"],
		["clear_queue", null],
		["abort", null],
		["prompt", "urgent now"],
		["follow_up", "keep queued"],
	]);
	expect(queue.items("sa").map((item) => item.submission.text)).toEqual([
		"keep queued",
	]);
});

test("composer send_now during a running turn preserves queued items across abort + prompt", async () => {
	const { queue, composer, sent } = createQueueRig();

	composer.setValue("wait after");
	await composer.submit("follow_up");

	composer.setSendMode("send_now");
	composer.setValue("do this immediately");
	await composer.submit();

	expect(
		sent.map((entry) => [entry.command.type, entry.command.message ?? null]),
	).toEqual([
		["follow_up", "wait after"],
		["clear_queue", null],
		["abort", null],
		["prompt", "do this immediately"],
		["follow_up", "wait after"],
	]);
	expect(queue.items("sa").map((item) => item.submission.text)).toEqual([
		"wait after",
	]);
});

test("stop clears locally queued messages, restores them to the draft, and aborts", async () => {
	const { queue, composer, sent } = createQueueRig();

	composer.setValue("queued one");
	await composer.submit();
	composer.setValue("queued two");
	await composer.submit("follow_up");
	composer.setValue("draft text");

	await composer.stop();

	expect(sent.map((entry) => entry.command.type)).toEqual([
		"steer",
		"follow_up",
		"clear_queue",
		"abort",
	]);
	expect(queue.items("sa")).toEqual([]);
	expect(composer.state().value).toBe("queued one\n\nqueued two\n\ndraft text");
});

test("foreign queue items from another client render read-only and cannot be mutated", () => {
	const { queue, pushQueueUpdate, pushEvent } = createQueueRig();

	pushQueueUpdate(["from mobile"], ["also mobile"]);
	const items = queue.items("sa");
	expect(
		items.map((item) => [item.id, item.kind, item.submission.text]),
	).toEqual([
		[null, "steer", "from mobile"],
		[null, "follow_up", "also mobile"],
	]);
	expect(queue.canMutate("sa")).toBe(false);

	pushEvent({
		sequence: 99,
		timestampMs: 2000,
		sessionKey: "sa",
		generation: 1,
		type: "process_state",
		state: "stopped",
	});
	expect(queue.items("sa")).toEqual([]);
});

test("second and third messages sent while the first prompt is still starting queue immediately and dispatch in order", async () => {
	const sent: Array<{ sessionKey: string; command: Record<string, unknown> }> =
		[];
	const queues = { steering: [] as string[], followUp: [] as string[] };
	let sequence = 1;
	let releaseStart!: () => void;
	const startGate = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});

	const { client: runtime } = scriptedClient({
		onCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			const type = String(command.type ?? "");
			if (type === "prompt") {
				return { success: true, data: { disposition: "started" } };
			}
			if (type === "steer" || type === "follow_up") {
				const message = String(command.message ?? "");
				if (type === "steer") queues.steering.push(message);
				else queues.followUp.push(message);
				queue.receive({
					sequence: ++sequence,
					timestampMs: 1000,
					sessionKey,
					generation: 1,
					type: "queue_update",
					steering: [...queues.steering],
					followUp: [...queues.followUp],
				});
				return { success: true, data: { disposition: "queued" } };
			}
			return { success: true };
		},
	});

	let initialized = false;
	const client: ComposerClient = {
		startChat: async (options) => {
			await startGate;
			initialized = true;
			return runtime.startChat(options);
		},
		chatState: async (sessionKey) =>
			initialized
				? ({
						sessionKey,
						projectId: "p1",
						prepared: true,
						initialized: true,
						activeTurn: true,
						snapshot: { state: "running", generation: 1 },
					} as unknown as ChatSessionRuntimeState)
				: null,
		sendChatCommand: runtime.sendChatCommand,
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p, name) => `/attachments/a/${name}`,
		removeChatFile: async () => {},
	};

	const queue = new ChatQueueStore(client);
	let liveTurn = false;
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: [],
	} as unknown as AppState;
	const composer = new ComposerStore({
		client,
		app: () => app,
		queue,
		transcript: {
			submitLocal: () => {
				liveTurn = true;
				return "local-1";
			},
			setLocalStatus: () => {},
			dropLocal: () => {
				liveTurn = false;
			},
			hasLiveTurn: () => liveTurn,
		},
	});
	composer.setTarget({ sessionKey: "sa", projectId: "p1" });

	// Send first message on an idle session; startup is still awaiting startGate.
	composer.setValue("first prompt");
	const firstSubmit = composer.submit();
	expect(composer.state().value).toBe("");
	expect(composer.state().sending).toBe(false);
	expect(composer.running()).toBe(true);

	// Immediately send second and third messages before the first finishes starting.
	composer.setValue("second steer");
	const secondSubmit = composer.submit();
	expect(composer.state().value).toBe("");

	composer.setValue("third follow-up");
	const thirdSubmit = composer.submit("follow_up");
	expect(composer.state().value).toBe("");

	// Both appear in the pending queue immediately and wait for the first prompt.
	expect(
		queue
			.items("sa")
			.map((item) => [item.kind, item.submission.text, item.inFlight]),
	).toEqual([
		["steer", "second steer", true],
		["follow_up", "third follow-up", true],
	]);
	expect(sent).toHaveLength(0);

	// Release startup; prompt dispatches first, then queued items in FIFO order.
	releaseStart();
	await Promise.all([firstSubmit, secondSubmit, thirdSubmit]);

	expect(
		sent.map((entry) => [entry.command.type, entry.command.message]),
	).toEqual([
		["prompt", "first prompt"],
		["steer", "second steer"],
		["follow_up", "third follow-up"],
	]);
	expect(
		queue
			.items("sa")
			.map((item) => [item.kind, item.submission.text, item.inFlight]),
	).toEqual([
		["steer", "second steer", false],
		["follow_up", "third follow-up", false],
	]);
	expect(queue.canMutate("sa")).toBe(true);
});

test("stopping a starting prompt cancels waiting queued messages and restores them to the draft", async () => {
	const sent: Array<{ sessionKey: string; command: Record<string, unknown> }> =
		[];
	let releaseStart!: () => void;
	const startGate = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});

	const { client: runtime } = scriptedClient({
		onCommand: (sessionKey, command) => {
			sent.push({ sessionKey, command });
			return { success: true, data: { disposition: "started" } };
		},
	});

	const client: ComposerClient = {
		startChat: async (options) => {
			await startGate;
			return runtime.startChat(options);
		},
		chatState: async () => null,
		sendChatCommand: runtime.sendChatCommand,
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p, name) => `/attachments/a/${name}`,
		removeChatFile: async () => {},
	};

	const queue = new ChatQueueStore(client);
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: [],
	} as unknown as AppState;
	const composer = new ComposerStore({
		client,
		app: () => app,
		queue,
	});
	composer.setTarget({ sessionKey: "sa", projectId: "p1" });

	composer.setValue("first prompt");
	const firstSubmit = composer.submit();
	composer.setValue("queued behind");
	const secondSubmit = composer.submit();

	expect(queue.items("sa").map((item) => item.submission.text)).toEqual([
		"queued behind",
	]);

	await composer.stop();
	releaseStart();
	await Promise.all([firstSubmit, secondSubmit]);

	expect(sent).toHaveLength(0);
	expect(queue.items("sa")).toEqual([]);
	expect(composer.state().value).toContain("first prompt");
	expect(composer.state().value).toContain("queued behind");
});

test("a racing prompt that Pi queues drops its local placeholder and becomes editable in the queue", async () => {
	const { client: runtime } = scriptedClient({
		onCommand: (sessionKey, command) => {
			if (command.type === "prompt") {
				queue.receive({
					sequence: 2,
					timestampMs: 1000,
					sessionKey,
					generation: 1,
					type: "queue_update",
					steering: [],
					followUp: [String(command.message ?? "")],
				});
				return { success: true, data: { disposition: "queued" } };
			}
			return { success: true };
		},
	});
	const client: ComposerClient = {
		startChat: runtime.startChat,
		chatState: async (sessionKey) =>
			({
				sessionKey,
				projectId: "p1",
				prepared: true,
				initialized: true,
				activeTurn: false,
			}) as unknown as ChatSessionRuntimeState,
		sendChatCommand: runtime.sendChatCommand,
		connectEvents: runtime.connectEvents,
		searchProjectFiles: async () => [],
		uploadChatFile: async (_p, name) => `/attachments/a/${name}`,
		removeChatFile: async () => {},
	};
	const queue = new ChatQueueStore(client);
	const dropped: string[] = [];
	const app = {
		...createAppState(),
		projects: [{ id: "p1", name: "Project" }],
		chatSessions: [],
	} as unknown as AppState;
	const composer = new ComposerStore({
		client,
		app: () => app,
		queue,
		transcript: {
			submitLocal: () => "local-race",
			setLocalStatus: () => {},
			dropLocal: (id) => dropped.push(id),
		},
	});
	composer.setTarget({ sessionKey: "sa", projectId: "p1" });

	composer.setValue("racing message");
	await composer.submit();

	expect(dropped).toEqual(["local-race"]);
	expect(
		queue.items("sa").map((item) => [item.kind, item.submission.text]),
	).toEqual([["follow_up", "racing message"]]);
	expect(queue.canMutate("sa")).toBe(true);
});
