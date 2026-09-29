const PRECACHE_ENTRIES = self.PILO_PRECACHE_MANIFEST;
const CACHE_PREFIX = "pilo-remote-shell";

function manifestFingerprint(entries) {
	let hash = 2166136261;
	for (const entry of entries) {
		const value = `${entry.url}:${entry.revision ?? ""}`;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
	}
	return (hash >>> 0).toString(36);
}

const CACHE_NAME = `${CACHE_PREFIX}-${manifestFingerprint(PRECACHE_ENTRIES)}`;
const PRECACHE_URLS = PRECACHE_ENTRIES.map(
	(entry) => new URL(entry.url, `${self.location.origin}/`).href,
);
const APP_SHELL_URL = new URL("/index.html", self.location.origin).href;

async function cleanupStaleCachesIfSafe() {
	const controlledClients = await self.clients.matchAll({ type: "window" });
	const allClients = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	const controlledIds = new Set(controlledClients.map((client) => client.id));
	if (allClients.some((client) => !controlledIds.has(client.id))) return;

	const keys = await caches.keys();
	await Promise.all(
		keys
			.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
			.map((key) => caches.delete(key)),
	);
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			await cache.addAll(PRECACHE_URLS);
		})(),
	);
});

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") {
		event.waitUntil(self.skipWaiting());
	}
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/v1/")) return;

	if (request.mode === "navigate") {
		const response = fetch(request).catch(async () => {
			const cache = await caches.open(CACHE_NAME);
			return (
				(await cache.match(APP_SHELL_URL)) ??
				new Response("Pilo is offline.", {
					status: 503,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				})
			);
		});
		event.respondWith(response);
		event.waitUntil(
			response.then(() => cleanupStaleCachesIfSafe()).catch(() => undefined),
		);
		return;
	}

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			const cached = await cache.match(request);
			if (cached) return cached;
			return fetch(request);
		})(),
	);
});
