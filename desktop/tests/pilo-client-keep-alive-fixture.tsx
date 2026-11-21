import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

import type { CacheKeepAliveSettings } from "@shared/cache-keep-alive";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import { NshPiloClient } from "../client/nsh-pilo-client";

const status = signal("loading cache keep-alive policies through the client");

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

/** Whether two policies agree on everything but `updatedAtMs`. */
function samePolicy(a: CacheKeepAliveSettings, b: CacheKeepAliveSettings) {
	return (
		a.connectionId === b.connectionId &&
		a.provider === b.provider &&
		a.modelId === b.modelId &&
		a.enabled === b.enabled &&
		a.cacheTtlSeconds === b.cacheTtlSeconds &&
		a.idleKeepAliveSeconds === b.idleKeepAliveSeconds
	);
}

async function run() {
	const fixture = new BootstrapFixture();
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	const received: PiloClientEvent[] = [];
	let wake = () => {};
	try {
		await client.connectEvents({
			onMessage: (message) => {
				if (message.type === "events") received.push(...message.events);
				wake();
			},
			onStatus: () => wake(),
		});
		// The first bootstrap creates the local connection.
		await client.bootstrap();
		assert(
			(await client.loadCacheKeepAliveSettings("local")).length === 0,
			"a connection with no saved policy returned one",
		);
		await expectError(
			client.loadCacheKeepAliveSettings("missing"),
			"Connection 'missing' was not found",
		);

		const policy: CacheKeepAliveSettings = {
			connectionId: "local",
			provider: "fixture",
			modelId: "model",
			enabled: true,
			cacheTtlSeconds: 300,
			idleKeepAliveSeconds: 1800,
			updatedAtMs: 0,
		};
		const saved = await client.saveCacheKeepAliveSettings(policy);
		assert(
			samePolicy(saved, policy) && saved.updatedAtMs > 0,
			`unexpected saved policy: ${JSON.stringify(saved)}`,
		);
		// The save also reaches listeners as an event carrying the policy.
		while (received.length === 0) {
			await new Promise<void>((resolve) => (wake = resolve));
		}
		const [event] = received;
		assert(
			event?.type === "cache_keep_alive_settings_changed" &&
				samePolicy(event.settings, saved) &&
				event.settings.updatedAtMs === saved.updatedAtMs,
			`unexpected policy event: ${JSON.stringify(event)}`,
		);

		await expectError(
			client.saveCacheKeepAliveSettings({ ...policy, cacheTtlSeconds: 9 }),
			"invalid cache keep-alive settings",
		);
		await expectError(
			client.saveCacheKeepAliveSettings({ ...policy, connectionId: "missing" }),
			"Connection 'missing' was not found",
		);

		// The Host, not the caller, sets `updatedAtMs`.
		const changed = { ...policy, enabled: false, cacheTtlSeconds: 600 };
		const updated = await client.saveCacheKeepAliveSettings({
			...changed,
			updatedAtMs: 1,
		});
		assert(
			samePolicy(updated, changed) && updated.updatedAtMs > saved.updatedAtMs,
			`unexpected updated policy: ${JSON.stringify(updated)}`,
		);
		const [loaded, ...others] =
			await client.loadCacheKeepAliveSettings("local");
		assert(
			others.length === 0 &&
				loaded !== undefined &&
				samePolicy(loaded, updated) &&
				loaded.updatedAtMs === updated.updatedAtMs,
			`the loaded policy differs from the saved one: ${JSON.stringify(loaded)}`,
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.loadCacheKeepAliveSettings("local"),
		"Pilo runtime has been shut down",
	);
	status.set("client cache keep-alive policies verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
