import { expect, test } from "nsh/test";

import type { TerminalEvent } from "../client/host-api";
import { type TerminalClient, TerminalStore } from "../state/terminal-store";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fakeTerminalClient() {
	let seq = 0;
	const writes: Array<{ terminalId: string; data: Uint8Array }> = [];
	const resizes: Array<{ terminalId: string; cols: number; rows: number }> = [];
	const closed: string[] = [];
	const queue: TerminalEvent[][] = [];
	let waiter: ((events: TerminalEvent[]) => void) | null = null;

	const push = (...events: TerminalEvent[]) => {
		if (waiter) {
			const next = waiter;
			waiter = null;
			next(events);
			return;
		}
		queue.push(events);
	};

	const closeStream = () => push();

	const client: TerminalClient = {
		openTerminal: async (projectId) => ({
			id: `t-${++seq}`,
			projectId,
			title: projectId,
		}),
		writeTerminal: async (terminalId, data) => {
			writes.push({ terminalId, data });
		},
		resizeTerminal: async (terminalId, cols, rows) => {
			resizes.push({ terminalId, cols, rows });
		},
		closeTerminal: async (terminalId) => {
			closed.push(terminalId);
		},
		nextTerminalEvents: async () => {
			const next = queue.shift();
			if (next) return next;
			return new Promise<TerminalEvent[]>((resolve) => {
				waiter = resolve;
			});
		},
	};

	return { client, writes, resizes, closed, push, closeStream };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("terminal store buffers early output and ignores writes/resizes after exit or error", async () => {
	const fake = fakeTerminalClient();
	const openDeferred = deferred<{
		id: string;
		projectId: string;
		title: string;
	}>();
	fake.client.openTerminal = () => openDeferred.promise;

	const store = new TerminalStore(fake.client);
	const opening = store.open("p1");
	// Early output arrives before openTerminal resolves.
	fake.push({ type: "output", terminalId: "t-1", data: "aGk=" });
	await flush();
	openDeferred.resolve({ id: "t-1", projectId: "p1", title: "P1" });
	await opening;

	expect(store.tabs().length).toBe(1);
	expect(store.activeId()).toBe("t-1");

	const received: string[] = [];
	const detach = store.attach("t-1", {
		output: (data) => received.push(`out:${data}`),
		exit: () => received.push("exit"),
		error: (message) => received.push(`err:${message}`),
	});
	expect(received).toEqual(["out:aGk="]);

	store.write("t-1", new Uint8Array([10]));
	store.resize("t-1", 100, 30);
	expect(fake.writes.length).toBe(1);
	expect(fake.resizes.length).toBe(1);

	fake.push({ type: "exit", terminalId: "t-1" });
	await flush();
	expect(store.tabs()[0]?.exited).toBe(true);
	expect(received).toEqual(["out:aGk=", "exit"]);

	// Exited terminals no longer forward writes or resizes.
	store.write("t-1", new Uint8Array([11]));
	store.resize("t-1", 120, 40);
	expect(fake.writes.length).toBe(1);
	expect(fake.resizes.length).toBe(1);

	detach();
	fake.closeStream();
});

test("terminal store marks errored tabs exited, switches active tab on close, and drops removed projects", async () => {
	const fake = fakeTerminalClient();
	const store = new TerminalStore(fake.client);
	await store.open("p1");
	await store.open("p1");
	await store.open("p2");

	fake.push({ type: "error", terminalId: "t-2", message: "boom" });
	await flush();
	expect(store.tabs().find((t) => t.id === "t-2")?.exited).toBe(true);
	store.write("t-2", new Uint8Array([65]));
	expect(fake.writes.length).toBe(0);

	store.select("t-1");
	store.close("t-1");
	expect(fake.closed).toEqual(["t-1"]);
	expect(store.activeId()).toBe("t-2");

	store.reconcileProjects(new Set(["p2"]));
	expect(store.tabs().map((t) => t.id)).toEqual(["t-3"]);
	expect(store.activeId()).toBeNull();
	fake.closeStream();
});
