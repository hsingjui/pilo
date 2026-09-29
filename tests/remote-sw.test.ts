import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
	new URL("../src/remote/sw.js", import.meta.url),
	"utf8",
);

type WorkerEvent = {
	data?: { type?: string };
	request?: Request;
	respondWith?: (response: Promise<Response>) => void;
	waitUntil?: (promise: Promise<unknown>) => void;
};

function loadWorker({
	controlledClientIds = ["current"],
	allClientIds = controlledClientIds,
}: {
	controlledClientIds?: string[];
	allClientIds?: string[];
} = {}) {
	const handlers = new Map<string, (event: WorkerEvent) => void>();
	const matches: string[] = [];
	const deletedCaches: string[] = [];
	const shell = new Response("shell");
	const cache = {
		addAll: async () => undefined,
		match: async (url: string) => {
			matches.push(url);
			return url === "https://pilo.test/index.html" ? shell : undefined;
		},
	};
	runInNewContext(source, {
		self: {
			PILO_PRECACHE_MANIFEST: [{ url: "index.html", revision: "v1" }],
			location: { origin: "https://pilo.test" },
			clients: {
				matchAll: async (options?: { includeUncontrolled?: boolean }) =>
					(options?.includeUncontrolled
						? allClientIds
						: controlledClientIds
					).map((id) => ({ id })),
			},
			skipWaiting: async () => undefined,
			addEventListener: (type: string, handler: (event: WorkerEvent) => void) =>
				handlers.set(type, handler),
		},
		caches: {
			open: async () => cache,
			match: async () => {
				throw new Error("API was cached");
			},
			keys: async () => ["pilo-remote-shell-stale", "unrelated-cache"],
			delete: async (key: string) => {
				deletedCaches.push(key);
				return true;
			},
		},
		fetch: async () => {
			throw new Error("offline");
		},
		Math,
		Response,
		Set,
		URL,
	});

	return { deletedCaches, handlers, matches };
}

function runNavigation(
	handler: (event: WorkerEvent) => void,
	url = "https://pilo.test/",
) {
	let response: Promise<Response> | undefined;
	let background: Promise<unknown> | undefined;
	handler({
		request: {
			url,
			method: "GET",
			mode: "navigate",
		} as Request,
		respondWith: (result) => {
			response = result;
		},
		waitUntil: (promise) => {
			background = promise;
		},
	});
	return { background, response };
}

test("remote worker keeps API network-only and falls back to the canonical shell", async () => {
	const { handlers, matches } = loadWorker();
	const fetchHandler = handlers.get("fetch");
	assert.ok(fetchHandler);

	let response: Promise<Response> | undefined;
	fetchHandler({
		request: new Request("https://pilo.test/api/v1/bootstrap"),
		respondWith: (result) => {
			response = result;
		},
	});
	assert.equal(response, undefined);

	const navigation = runNavigation(
		fetchHandler,
		"https://pilo.test/?pair=secret",
	);
	assert.equal(
		await navigation.response?.then((result) => result.text()),
		"shell",
	);
	await navigation.background;
	assert.deepEqual(matches, ["https://pilo.test/index.html"]);
});

test("remote worker keeps stale caches while an older client is still open", async () => {
	const { deletedCaches, handlers } = loadWorker({
		controlledClientIds: ["current"],
		allClientIds: ["current", "older-tab"],
	});
	const fetchHandler = handlers.get("fetch");
	assert.ok(fetchHandler);

	const navigation = runNavigation(fetchHandler);
	await navigation.response;
	await navigation.background;
	assert.deepEqual(deletedCaches, []);
});

test("remote worker deletes stale shell caches after all clients move to it", async () => {
	const { deletedCaches, handlers } = loadWorker({
		controlledClientIds: ["current", "second-tab"],
		allClientIds: ["current", "second-tab"],
	});
	const fetchHandler = handlers.get("fetch");
	assert.ok(fetchHandler);

	const navigation = runNavigation(fetchHandler);
	await navigation.response;
	await navigation.background;
	assert.deepEqual(deletedCaches, ["pilo-remote-shell-stale"]);
});
