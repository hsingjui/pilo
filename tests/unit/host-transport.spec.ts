import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostClient } from "@shared/api/host-client";
import { HostApiError, type TerminalEvent } from "@shared/api/host-methods";
import {
	HttpTransport,
	MemoryCursorStore,
	type FetchLike,
	type FetchRequestInitLike,
	type FetchResponseLike,
	type HostTransportConnectionState,
	type SchedulerLike,
	type WebSocketLike,
} from "@shared/api/host-transport";
import type { PiloClientEventMessage } from "@shared/api/pilo-client";

class FakeScheduler implements SchedulerLike {
	private currentTime = 1_000;
	private nextId = 1;
	private readonly timers = new Map<
		number,
		{ at: number; callback: () => void }
	>();

	now(): number {
		return this.currentTime;
	}

	setTimeout(callback: () => void, ms: number): number {
		const id = this.nextId++;
		this.timers.set(id, { at: this.currentTime + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") {
			this.timers.delete(handle);
		}
	}

	advance(ms: number): void {
		const target = this.currentTime + ms;
		while (true) {
			let earliestId: number | null = null;
			let earliestAt = target + 1;
			for (const [id, entry] of this.timers) {
				if (entry.at <= target && entry.at < earliestAt) {
					earliestId = id;
					earliestAt = entry.at;
				}
			}
			if (earliestId === null) break;
			const entry = this.timers.get(earliestId);
			this.timers.delete(earliestId);
			this.currentTime = entry!.at;
			entry!.callback();
		}
		this.currentTime = target;
	}
}

class FakeSocket implements WebSocketLike {
	readonly url: string;
	readonly protocols: string[] | undefined;
	readonly sent: string[] = [];
	readyState = 1;
	private readonly messageListeners = new Set<
		(event: { data: unknown }) => void
	>();
	private readonly errorListeners = new Set<(event: unknown) => void>();
	private readonly closeListeners = new Set<(event: unknown) => void>();

	constructor(url: string, protocols?: string[]) {
		this.url = url;
		this.protocols = protocols;
	}

	addEventListener(
		type: "message" | "error" | "close",
		listener: ((event: { data: unknown }) => void) | ((event: unknown) => void),
	): void {
		if (type === "message") {
			this.messageListeners.add(listener as (event: { data: unknown }) => void);
		} else if (type === "error") {
			this.errorListeners.add(listener as (event: unknown) => void);
		} else {
			this.closeListeners.add(listener as (event: unknown) => void);
		}
	}

	removeEventListener(
		type: "message" | "error" | "close",
		listener: ((event: { data: unknown }) => void) | ((event: unknown) => void),
	): void {
		if (type === "message") {
			this.messageListeners.delete(
				listener as (event: { data: unknown }) => void,
			);
		} else if (type === "error") {
			this.errorListeners.delete(listener as (event: unknown) => void);
		} else {
			this.closeListeners.delete(listener as (event: unknown) => void);
		}
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	emitMessage(payload: unknown): void {
		const data = JSON.stringify(payload);
		for (const listener of Array.from(this.messageListeners)) {
			listener({ data });
		}
	}

	emitClose(): void {
		this.readyState = 3;
		for (const listener of Array.from(this.closeListeners)) {
			listener({});
		}
	}
}

function makeHello(overrides: Record<string, unknown> = {}) {
	return {
		type: "hello",
		hostId: "host-a",
		hostName: "Host A",
		deviceId: "dev-1",
		protocolVersion: "2.0",
		scopes: "chat,workspace",
		latestSequence: 10,
		capabilities: {
			platform: "macos",
			wsl: false,
			methods: ["host.bootstrap", "project.list"],
			methodsHash: "abc123",
		},
		...overrides,
	};
}

function jsonResponse(status: number, payload: unknown): FetchResponseLike {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(payload),
		arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
		text: () => Promise.resolve(JSON.stringify(payload)),
	};
}

describe("HttpTransport & HostClient", () => {
	it("routes call, upload, and download to /api/v2 endpoints and surfaces HostApiError", async () => {
		const calls: { url: string; init?: FetchRequestInitLike }[] = [];
		const sockets: FakeSocket[] = [];
		let unauthorizedCalls = 0;
		const fetchFn: FetchLike = (url, init) => {
			calls.push({ url, init });
			if (url.includes("/api/v2/call/project.list")) {
				return Promise.resolve(jsonResponse(200, { ok: true, result: [] }));
			}
			if (url.includes("/api/v2/call/project.add")) {
				return Promise.resolve(
					jsonResponse(403, {
						ok: false,
						error: {
							code: "forbidden",
							message: "missing workspace scope",
							retryable: false,
						},
					}),
				);
			}
			if (url.includes("/api/v2/upload/chat.files.upload")) {
				return Promise.resolve(
					jsonResponse(200, { ok: true, result: "uploads/a.txt" }),
				);
			}
			if (url.includes("/api/v2/blob/files.image")) {
				const buf = new Uint8Array([1, 2, 3]).buffer;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.reject(new Error("binary")),
					arrayBuffer: () => Promise.resolve(buf),
					text: () => Promise.resolve(""),
				});
			}
			return Promise.resolve(
				jsonResponse(401, {
					ok: false,
					error: {
						code: "unauthorized",
						message: "revoked",
						retryable: false,
					},
				}),
			);
		};

		const transport = new HttpTransport({
			origin: "http://127.0.0.1:7891/",
			tokens: { getToken: () => "tok-123" },
			fetch: fetchFn,
			createWebSocket: (url, protocols) => {
				const socket = new FakeSocket(url, protocols);
				sockets.push(socket);
				return socket;
			},
			onUnauthorized: () => {
				unauthorizedCalls += 1;
			},
		});
		const client = new HostClient(transport);

		const projects = client.listProjects();
		const denied = assert.rejects(
			() => client.addProject("local", "/tmp"),
			(err: unknown) =>
				err instanceof HostApiError &&
				err.code === "forbidden" &&
				err.retryable === false,
		);
		const upload = client.uploadChatFile(
			"p1",
			"a.txt",
			new Uint8Array([65, 66]),
		);
		const image = client.readProjectImage("p1", "pic.png");
		assert.equal(calls.length, 0);
		assert.equal(sockets.length, 1);
		sockets[0]!.emitMessage(
			makeHello({
				protocolVersion: "2.4",
				scopes: "chat",
				capabilities: {
					methods: [
						"project.list",
						"project.add",
						"chat.files.upload",
						"files.image",
						"preferences.get",
					],
				},
			}),
		);
		assert.deepEqual(await projects, []);
		assert.equal(
			calls[0]!.url,
			"http://127.0.0.1:7891/api/v2/call/project.list",
		);
		assert.equal(calls[0]!.init?.headers?.authorization, "Bearer tok-123");

		await denied;

		const uploaded = await upload;
		assert.equal(uploaded, "uploads/a.txt");
		assert.ok(
			calls[2]!.url.includes(
				"/api/v2/upload/chat.files.upload?projectId=p1&name=a.txt",
			),
		);

		const bytes = await image;
		assert.deepEqual([...bytes], [1, 2, 3]);
		assert.ok(
			calls[3]!.url.includes(
				"/api/v2/blob/files.image?projectId=p1&path=pic.png",
			),
		);
		assert.equal(client.hasMethod("project.list"), true);
		assert.equal(client.hasMethod("terminal.open"), false);
		await assert.rejects(
			client.openTerminal("p1", 80, 24),
			/does not support terminal.open/,
		);
		assert.equal(calls.length, 4);

		await assert.rejects(
			() => client.loadPreferences(),
			(err: unknown) =>
				err instanceof HostApiError && err.code === "unauthorized",
		);
		assert.equal(unauthorizedCalls, 1);

		transport.dispose();
	});

	it("reconnects with backoff, replays from per-hostId cursor, and detects sequence regression", () => {
		const scheduler = new FakeScheduler();
		const cursors = new MemoryCursorStore();
		cursors.setCursor("host-a", 42);
		cursors.setCursor("host-b", 99);

		const sockets: FakeSocket[] = [];
		const messages: PiloClientEventMessage[] = [];
		const statuses: boolean[] = [];

		const transport = new HttpTransport({
			origin: "http://127.0.0.1:7891",
			hostId: "host-a",
			tokens: { getToken: () => "tok-a" },
			cursors,
			scheduler,
			reconnectDelaysMs: [500, 1_000, 2_000],
			cursorFlushDelayMs: 100,
			fetch: () => Promise.resolve(jsonResponse(200, { ok: true, result: {} })),
			createWebSocket: (url, protocols) => {
				const sock = new FakeSocket(url, protocols);
				sockets.push(sock);
				return sock;
			},
		});

		const unsubscribe = transport.events().subscribeEvents({
			onMessage: (m) => messages.push(m),
			onStatus: (s) => statuses.push(s),
		});

		assert.equal(sockets.length, 1);
		assert.equal(sockets[0]!.url, "ws://127.0.0.1:7891/api/v2/events?after=42");
		assert.deepEqual(sockets[0]!.protocols, ["pilo", "pilo-token.tok-a"]);

		// Host A replies with normal latestSequence >= 42 and sends event 45.
		sockets[0]!.emitMessage(
			makeHello({ hostId: "host-a", latestSequence: 44 }),
		);
		sockets[0]!.emitMessage({
			type: "events",
			events: [{ sequence: 45, type: "process_state" }],
		});
		scheduler.advance(150);
		assert.equal(cursors.getCursor("host-a"), 45);
		assert.equal(cursors.getCursor("host-b"), 99);

		// Socket drops -> backoff 500ms -> reconnects with after=45.
		sockets[0]!.emitClose();
		assert.equal(statuses.at(-1), false);
		scheduler.advance(499);
		assert.equal(sockets.length, 1);
		scheduler.advance(1);
		assert.equal(sockets.length, 2);
		assert.equal(sockets[1]!.url, "ws://127.0.0.1:7891/api/v2/events?after=45");

		// Host A restarted so latestSequence regressed from 45 -> 3!
		sockets[1]!.emitMessage(makeHello({ hostId: "host-a", latestSequence: 3 }));
		assert.equal(cursors.getCursor("host-a"), 0);
		assert.equal(cursors.getCursor("host-b"), 99);
		assert.equal(messages.at(-1)?.type, "resyncRequired");
		assert.equal(
			messages.at(-1)?.type === "resyncRequired"
				? messages.at(-1)!.latestSequence
				: -1,
			3,
		);

		unsubscribe();
		transport.dispose();
	});

	it("rejects incompatible protocol major version and stops reconnecting", async () => {
		const scheduler = new FakeScheduler();
		const sockets: FakeSocket[] = [];
		const states: HostTransportConnectionState[] = [];
		let incompatible: [string, string] | null = null;

		const transport = new HttpTransport({
			origin: "https://host-b.example",
			tokens: { getToken: () => "tok-b" },
			scheduler,
			fetch: () => {
				assert.fail("Incompatible Host must not receive a business request");
			},
			createWebSocket: (url, protocols) => {
				const sock = new FakeSocket(url, protocols);
				sockets.push(sock);
				return sock;
			},
			onIncompatibleProtocol: (hostVersion, clientVersion) => {
				incompatible = [hostVersion, clientVersion];
			},
		});

		transport.events().onConnectionState?.((s) => states.push(s));
		transport.events().subscribeEvents({
			onMessage: () => undefined,
			onStatus: () => undefined,
		});

		assert.equal(sockets.length, 1);
		assert.ok(sockets[0]!.url.startsWith("wss://host-b.example/api/v2/events"));
		const rejected = Promise.all([
			assert.rejects(
				transport.call("project.list", {}),
				/Incompatible Host protocol version 3.0/,
			),
			assert.rejects(
				transport.upload("chat.files.upload", {}, new Uint8Array()),
				/Incompatible Host protocol/,
			),
			assert.rejects(
				transport.download("files.image", {}),
				/Incompatible Host protocol/,
			),
		]);

		sockets[0]!.emitMessage(makeHello({ protocolVersion: "3.0" }));
		await rejected;
		await assert.rejects(
			transport.call("project.list", {}),
			/Incompatible Host protocol/,
		);
		assert.deepEqual(incompatible, ["3.0", "2.0"]);
		assert.equal(transport.currentState, "incompatible");
		assert.equal(sockets[0]!.readyState, 3);

		// Advancing timers must not attempt to reconnect.
		scheduler.advance(30_000);
		assert.equal(sockets.length, 1);
		assert.ok(states.includes("incompatible"));

		transport.dispose();
	});

	it("routes terminal WS events, re-subscribes on reconnect, and probes after background resume", () => {
		const scheduler = new FakeScheduler();
		const sockets: FakeSocket[] = [];
		const terminalEvents: TerminalEvent[] = [];
		let triggerBackground: (() => void) | undefined;
		let triggerForeground: (() => void) | undefined;

		const transport = new HttpTransport({
			origin: "http://127.0.0.1:7891",
			tokens: { getToken: () => "tok-term" },
			scheduler,
			reconnectDelaysMs: [200],
			probeTimeoutMs: 1_000,
			foregroundProbeMinHiddenMs: 2_000,
			network: {
				onBackground: (cb) => {
					triggerBackground = cb;
					return () => undefined;
				},
				onForeground: (cb) => {
					triggerForeground = cb;
					return () => undefined;
				},
			},
			fetch: () => Promise.resolve(jsonResponse(200, { ok: true, result: {} })),
			createWebSocket: (url, protocols) => {
				const sock = new FakeSocket(url, protocols);
				sockets.push(sock);
				return sock;
			},
		});

		const unsubTerm = transport
			.events()
			.subscribeTerminal("term-1", (ev) => terminalEvents.push(ev));

		assert.equal(sockets.length, 1);
		sockets[0]!.emitMessage(makeHello());
		assert.deepEqual(
			sockets[0]!.sent.map((s) => JSON.parse(s)),
			[{ type: "terminal.subscribe", terminalId: "term-1" }],
		);

		sockets[0]!.emitMessage({
			type: "terminal",
			event: "output",
			terminalId: "term-1",
			data: "aGVsbG8=",
		});
		assert.deepEqual(terminalEvents, [
			{ type: "output", terminalId: "term-1", data: "aGVsbG8=" },
		]);

		// Simulate background for 3s then foreground -> sends ping -> no pong -> reconnects & re-subscribes!
		triggerBackground?.();
		scheduler.advance(3_000);
		triggerForeground?.();
		assert.deepEqual(JSON.parse(sockets[0]!.sent.at(-1)!), { type: "ping" });

		scheduler.advance(1_000);
		assert.equal(sockets.length, 2);
		sockets[1]!.emitMessage(makeHello());
		assert.deepEqual(
			sockets[1]!.sent.map((s) => JSON.parse(s)),
			[{ type: "terminal.subscribe", terminalId: "term-1" }],
		);

		unsubTerm();
		assert.deepEqual(JSON.parse(sockets[1]!.sent.at(-1)!), {
			type: "terminal.unsubscribe",
			terminalId: "term-1",
		});

		transport.dispose();
	});

	it("reconnects with the discovered hostId cursor on first connect and on same-address host swap", () => {
		const scheduler = new FakeScheduler();
		const cursors = new MemoryCursorStore();
		cursors.setCursor("host-alpha", 15);
		cursors.setCursor("host-beta", 7);

		const sockets: FakeSocket[] = [];
		const messages: PiloClientEventMessage[] = [];
		const transport = new HttpTransport({
			origin: "http://127.0.0.1:7891",
			tokens: { getToken: () => "tok-swap" },
			cursors,
			scheduler,
			reconnectDelaysMs: [100],
			fetch: () => Promise.resolve(jsonResponse(200, { ok: true, result: {} })),
			createWebSocket: (url, protocols) => {
				const sock = new FakeSocket(url, protocols);
				sockets.push(sock);
				return sock;
			},
		});

		transport.events().subscribeEvents({
			onMessage: (m) => messages.push(m),
			onStatus: () => undefined,
		});

		// 1. First connect has unknown hostId -> sends after=0, hello reveals host-alpha (stored 15)
		//    -> immediately closes first socket and reconnects with after=15 without emitting hello for socket 0.
		assert.equal(sockets.length, 1);
		assert.ok(sockets[0]!.url.endsWith("after=0"));
		sockets[0]!.emitMessage(
			makeHello({ hostId: "host-alpha", latestSequence: 20 }),
		);
		assert.equal(sockets[0]!.readyState, 3);
		assert.equal(sockets.length, 2);
		assert.ok(sockets[1]!.url.endsWith("after=15"));
		assert.equal(messages.length, 0);

		// Second socket completes hello and advances host-alpha cursor to 42.
		sockets[1]!.emitMessage(
			makeHello({ hostId: "host-alpha", latestSequence: 42 }),
		);
		sockets[1]!.emitMessage({
			type: "events",
			events: [{ type: "chat_state", sequence: 42 } as never],
		});
		scheduler.advance(1_000);
		assert.equal(cursors.getCursor("host-alpha"), 42);

		// 2. Socket closes and same origin now serves host-beta (stored cursor 7 < 42).
		//    Must NOT take max(42, 7); must switch to 7 and reconnect with after=7 while keeping host-alpha=42.
		sockets[1]!.emitClose();
		scheduler.advance(100);
		assert.equal(sockets.length, 3);
		assert.ok(sockets[2]!.url.endsWith("after=42"));

		sockets[2]!.emitMessage(
			makeHello({ hostId: "host-beta", latestSequence: 12 }),
		);
		assert.equal(sockets[2]!.readyState, 3);
		assert.equal(sockets.length, 4);
		assert.ok(sockets[3]!.url.endsWith("after=7"));
		assert.equal(transport.currentHostId, "host-beta");
		assert.equal(cursors.getCursor("host-alpha"), 42);

		sockets[3]!.emitMessage(
			makeHello({ hostId: "host-beta", latestSequence: 12 }),
		);
		sockets[3]!.emitMessage({
			type: "events",
			events: [{ type: "chat_state", sequence: 9 } as never],
		});
		scheduler.advance(1_000);
		assert.equal(cursors.getCursor("host-beta"), 9);
		assert.equal(cursors.getCursor("host-alpha"), 42);

		transport.dispose();
	});

	it("bounds hostId mismatch reconnects to at most once per connection cycle", () => {
		const scheduler = new FakeScheduler();
		const cursors = new MemoryCursorStore();
		cursors.setCursor("host-a", 10);
		cursors.setCursor("host-b", 25);

		const sockets: FakeSocket[] = [];
		const messages: PiloClientEventMessage[] = [];
		const transport = new HttpTransport({
			origin: "http://127.0.0.1:7891",
			tokens: { getToken: () => "tok-flap" },
			cursors,
			scheduler,
			reconnectDelaysMs: [100],
			fetch: () => Promise.resolve(jsonResponse(200, { ok: true, result: {} })),
			createWebSocket: (url, protocols) => {
				const sock = new FakeSocket(url, protocols);
				sockets.push(sock);
				return sock;
			},
		});

		transport.events().subscribeEvents({
			onMessage: (m) => messages.push(m),
			onStatus: () => undefined,
		});

		// Socket 0 sends after=0 -> receives host-a (cursor 10) -> switches once to Socket 1 (after=10).
		assert.equal(sockets.length, 1);
		sockets[0]!.emitMessage(
			makeHello({ hostId: "host-a", latestSequence: 12 }),
		);
		assert.equal(sockets.length, 2);
		assert.ok(sockets[1]!.url.endsWith("after=10"));

		// Socket 1 flaps to host-b (cursor 25) -> must NOT spin-reconnect a second time;
		// adopts host-b as the latest hostId and completes hello.
		sockets[1]!.emitMessage(
			makeHello({ hostId: "host-b", latestSequence: 30 }),
		);
		assert.equal(sockets.length, 2);
		assert.equal(transport.currentHostId, "host-b");
		assert.equal(transport.currentState, "connected");
		assert.equal(messages.length, 1);
		assert.equal(messages[0]!.type, "hello");

		transport.dispose();
	});
});
