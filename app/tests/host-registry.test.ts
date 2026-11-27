import { expect, test } from "nsh/test";

import { HostClient } from "@shared/api/host-client";
import type {
	HostEventStream,
	HostTransport,
	WebSocketLike,
} from "@shared/api/host-transport";
import { LOCAL_HOST_ID } from "@shared/host-id";
import {
	REMOTE_HOSTS_STORAGE_KEY,
	serializeRemoteHostRecords,
	type RemoteHostRecord,
} from "@shared/remote-hosts";
import { HostRegistry } from "../hosts/host-registry";
import { HostSession } from "../hosts/host-session";
import type { DesktopShell } from "../shell/desktop-shell";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, ms = 3_000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		// oxlint-disable-next-line no-await-in-loop -- Polling.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const idleStream: HostEventStream = {
	subscribeEvents: () => () => undefined,
	subscribeTerminal: () => () => undefined,
};

/** The embedded Host's session; these tests never start it. */
function localSession() {
	const transport: HostTransport = {
		call: () => Promise.resolve(undefined as never),
		upload: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		events: () => idleStream,
		dispose: () => undefined,
	};
	return new HostSession({
		hostId: LOCAL_HOST_ID,
		kind: "local",
		client: new HostClient(transport),
		shell: {} as DesktopShell,
	});
}

class FakeSocket implements WebSocketLike {
	readonly sent: string[] = [];
	readyState = 1;
	private readonly listeners = new Map<string, Set<(event: never) => void>>();

	constructor(readonly url: string) {}

	addEventListener(type: string, listener: (event: never) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: (event: never) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	emit(type: string, event: unknown) {
		for (const listener of [...(this.listeners.get(type) ?? [])])
			listener(event as never);
	}

	emitClose() {
		this.readyState = 3;
		this.emit("close", {});
	}
}

function hello(hostId: string, scopes = "chat,workspace") {
	return {
		type: "hello",
		hostId,
		hostName: hostId,
		deviceId: "device-1",
		protocolVersion: "2.0",
		scopes,
		latestSequence: 0,
		capabilities: {
			platform: "linux",
			wsl: false,
			methods: ["project.add", "project.remove", "terminal.open"],
			methodsHash: "m",
		},
	};
}

function response(status: number, payload: unknown = { ok: true, result: {} }) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(),
		json: () => Promise.resolve(payload),
		text: () => Promise.resolve(JSON.stringify(payload)),
		arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
	} as unknown as Response;
}

const LAN = { id: "lan", name: "", baseUrl: "http://192.168.1.2:7890" };
const HTTPS = { id: "public", name: "", baseUrl: "https://b.example.com" };
const CGNAT = { id: "ts", name: "", baseUrl: "http://100.64.0.2:7890" };

function harness(
	record: Partial<RemoteHostRecord> = {},
	token: () => Promise<string | null> = () => Promise.resolve("token"),
) {
	const saved: RemoteHostRecord = {
		hostId: "host-b",
		name: "B",
		addresses: [LAN, HTTPS],
		preferredAddressId: "lan",
		deviceId: "device-1",
		scopes: "chat,workspace",
		...record,
	};
	const storage = new Map<string, string>([
		[REMOTE_HOSTS_STORAGE_KEY, serializeRemoteHostRecords([saved])],
	]);
	const fetches: string[] = [];
	/** Per origin: the status `preferences.get` answers with, or a pending reply. */
	const tokenStatus = new Map<string, number | Promise<number>>();
	const revokeStatus = { value: 200 };
	const hellos = new Map<string, ReturnType<typeof hello> | null>();
	const sockets: FakeSocket[] = [];
	const fetchFn = (async (url: string) => {
		fetches.push(url);
		const { origin, pathname } = new URL(url);
		if (pathname === "/api/v2/call/preferences.get") {
			const status = tokenStatus.get(origin);
			if (status === undefined) throw new Error("unreachable");
			return response(await status);
		}
		if (pathname === "/api/v2/call/device.revokeSelf")
			return response(revokeStatus.value);
		if (pathname === "/api/v1/auth/device") return response(200, {});
		return response(503, {
			ok: false,
			error: { code: "unavailable", message: "fake", retryable: true },
		});
	}) as typeof fetch;
	const registry = new HostRegistry({
		local: localSession(),
		shell: {} as DesktopShell,
		credentials: {
			remoteHostToken: token,
			saveRemoteHostToken: () => Promise.resolve(),
			deleteRemoteHostToken: () => Promise.resolve(),
		},
		storage: {
			getItem: (key) => Promise.resolve(storage.get(key) ?? null),
			setItem: (key, value) => {
				storage.set(key, value);
				return Promise.resolve();
			},
			removeItem: (key) => {
				storage.delete(key);
				return Promise.resolve();
			},
		},
		fetch: fetchFn,
		reconnectDelaysMs: [10],
		createWebSocket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			const origin = new URL(url).origin.replace(/^ws/, "http");
			setTimeout(() => {
				const message = hellos.get(origin);
				if (message && socket.readyState === 1)
					socket.emit("message", { data: JSON.stringify(message) });
			}, 0);
			return socket;
		},
	});
	const status = () =>
		registry.entries().find((entry) => entry.hostId === "host-b")?.status;
	const probes = () =>
		fetches.filter((url) => url.endsWith("/preferences.get"));
	return {
		registry,
		tokenStatus,
		revokeStatus,
		hellos,
		sockets,
		status,
		probes,
		fetches,
	};
}

test("a disconnect while the token is read drops the connect attempt", async () => {
	const token = deferred<string | null>();
	const h = harness({}, () => token.promise);
	h.tokenStatus.set(LAN.baseUrl, 200);
	h.hellos.set(LAN.baseUrl, hello("host-b"));
	await h.registry.load();
	expect(h.status()).toBe("connecting");
	h.registry.disconnect("host-b");
	token.resolve("token");
	await flush();
	await flush();
	expect(h.probes()).toEqual([]);
	expect(h.registry.sessions().length).toBe(1);
	expect(h.status()).toBe("disconnected");
	await h.registry.shutdown();
});

test("removing a Host while its address is probed opens no session", async () => {
	const h = harness();
	const reply = deferred<number>();
	h.tokenStatus.set(LAN.baseUrl, reply.promise);
	h.hellos.set(LAN.baseUrl, hello("host-b"));
	await h.registry.load();
	await until(() => h.probes().length === 1);
	expect(await h.registry.remove("host-b")).toBe(true);
	reply.resolve(200);
	await flush();
	await flush();
	expect(h.sockets.length).toBe(0);
	expect(h.registry.sessions().length).toBe(1);
	expect(h.registry.entries().length).toBe(1);
	await h.registry.shutdown();
});

test("401 asks to pair again", async () => {
	const h = harness();
	h.tokenStatus.set(LAN.baseUrl, 401);
	h.tokenStatus.set(HTTPS.baseUrl, 200);
	await h.registry.load();
	await until(() => h.status() === "unauthorized");
	// The search stops at the rejection: the next address is not asked.
	expect(h.probes().length).toBe(1);
	await h.registry.shutdown();
});

test("429 is not taken as revoked: it retries later and removing says it was not told", async () => {
	const h = harness();
	h.tokenStatus.set(LAN.baseUrl, 429);
	h.tokenStatus.set(HTTPS.baseUrl, 429);
	await h.registry.load();
	await until(() => h.status() === "rateLimited");
	expect(h.registry.sessions().length).toBe(1);
	h.revokeStatus.value = 429;
	expect(await h.registry.remove("host-b")).toBe(false);
	await h.registry.shutdown();
});

test("an address where another Host answers falls back to the next one", async () => {
	const h = harness();
	h.tokenStatus.set(LAN.baseUrl, 200);
	h.tokenStatus.set(HTTPS.baseUrl, 200);
	h.hellos.set(LAN.baseUrl, hello("host-x"));
	h.hellos.set(HTTPS.baseUrl, hello("host-b"));
	await h.registry.load();
	await until(() => h.status() === "connected");
	expect(h.sockets.at(-1)?.url.startsWith("wss://b.example.com/")).toBe(true);
	await h.registry.shutdown();
});

test("plain-http fallbacks outside private networks need consent from pairing", async () => {
	const skipped = harness({ addresses: [LAN, CGNAT] });
	await skipped.registry.load();
	await until(() => skipped.status() === "offline");
	expect(skipped.probes().map((url) => new URL(url).origin)).toEqual([
		LAN.baseUrl,
	]);
	await skipped.registry.shutdown();

	const allowed = harness({
		addresses: [LAN, CGNAT],
		plaintextAddressIds: ["ts"],
	});
	await allowed.registry.load();
	await until(() => allowed.status() === "offline");
	expect(allowed.probes().map((url) => new URL(url).origin)).toEqual([
		LAN.baseUrl,
		CGNAT.baseUrl,
	]);
	await allowed.registry.shutdown();
});

test("a reconnect with the same scopes keeps the Host's access, so the shell stays mounted", async () => {
	const h = harness();
	h.tokenStatus.set(LAN.baseUrl, 200);
	h.hellos.set(LAN.baseUrl, hello("host-b"));
	await h.registry.load();
	await until(() => h.status() === "connected");
	const session = h.registry.entries()[1]?.session;
	await until(() => h.registry.access("host-b").methods !== null);
	const access = h.registry.access("host-b");

	let count = h.sockets.length;
	h.sockets.at(-1)?.emitClose();
	await until(() => h.sockets.length > count && h.status() === "connected");
	await flush();
	expect(h.registry.access("host-b")).toBe(access);
	expect(h.registry.entries()[1]?.session).toBe(session);

	h.hellos.set(LAN.baseUrl, hello("host-b", "chat"));
	count = h.sockets.length;
	h.sockets.at(-1)?.emitClose();
	await until(() => h.sockets.length > count && h.status() === "connected");
	await until(() => h.registry.access("host-b").scopes === "chat");
	expect(h.registry.access("host-b")).not.toBe(access);
	await h.registry.shutdown();
});

test("when the event socket cannot come back, the next address takes over", async () => {
	const h = harness();
	h.tokenStatus.set(LAN.baseUrl, 200);
	h.tokenStatus.set(HTTPS.baseUrl, 200);
	h.hellos.set(LAN.baseUrl, hello("host-b"));
	h.hellos.set(HTTPS.baseUrl, hello("host-b"));
	await h.registry.load();
	await until(() => h.status() === "connected");
	expect(h.sockets.at(-1)?.url.startsWith("ws://192.168.1.2:7890/")).toBe(true);

	h.tokenStatus.delete(LAN.baseUrl);
	h.hellos.set(LAN.baseUrl, null);
	h.sockets.at(-1)?.emitClose();
	await until(
		() =>
			h.status() === "connected" &&
			Boolean(h.sockets.at(-1)?.url.startsWith("wss://b.example.com/")),
	);
	await h.registry.shutdown();
});

test("a dropped socket whose token is now rejected asks to pair again; 429 only waits", async () => {
	const limited = harness({ addresses: [LAN] });
	limited.tokenStatus.set(LAN.baseUrl, 200);
	limited.hellos.set(LAN.baseUrl, hello("host-b"));
	await limited.registry.load();
	await until(() => limited.status() === "connected");
	limited.tokenStatus.set(LAN.baseUrl, 429);
	limited.hellos.set(LAN.baseUrl, null);
	limited.sockets.at(-1)?.emitClose();
	await until(() => limited.status() === "rateLimited");
	expect(limited.registry.sessions().length).toBe(2);
	await limited.registry.shutdown();

	const revoked = harness({ addresses: [LAN] });
	revoked.tokenStatus.set(LAN.baseUrl, 200);
	revoked.hellos.set(LAN.baseUrl, hello("host-b"));
	await revoked.registry.load();
	await until(() => revoked.status() === "connected");
	revoked.tokenStatus.set(LAN.baseUrl, 401);
	revoked.hellos.set(LAN.baseUrl, null);
	revoked.sockets.at(-1)?.emitClose();
	await until(() => revoked.status() === "unauthorized");
	expect(revoked.registry.sessions().length).toBe(1);
	await revoked.registry.shutdown();
});
