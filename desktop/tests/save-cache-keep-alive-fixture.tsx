import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

const status = signal("saving cache keep-alive policies");

const policy = {
	connectionId: "local",
	provider: "fixture",
	modelId: "model",
	enabled: true,
	cacheTtlSeconds: 300,
	idleKeepAliveSeconds: 1800,
};
type Policy = typeof policy & { updatedAtMs: number };

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

function expectPolicy(
	actual: unknown,
	expected: typeof policy,
	previousRevision: number,
) {
	const saved = actual as Policy;
	if (
		saved.connectionId !== expected.connectionId ||
		saved.provider !== expected.provider ||
		saved.modelId !== expected.modelId ||
		saved.enabled !== expected.enabled ||
		saved.cacheTtlSeconds !== expected.cacheTtlSeconds ||
		saved.idleKeepAliveSeconds !== expected.idleKeepAliveSeconds ||
		!(saved.updatedAtMs > previousRevision)
	) {
		throw new Error(`unexpected saved policy: ${JSON.stringify(saved)}`);
	}
	return saved;
}

function expectPolicyList(actual: unknown, expected: Policy) {
	if (JSON.stringify(actual) !== JSON.stringify([expected])) {
		throw new Error(`unexpected policies: ${JSON.stringify(actual)}`);
	}
}

async function expectSettingsEvent(
	pilo: Pilo,
	sequence: number,
	settings: Policy,
) {
	const batch = (await pilo.nextEvents(1)) as {
		type: string;
		events?: { type: string; sequence: number; settings: Policy }[];
	};
	const event = batch.events?.[0];
	if (
		batch.type !== "events" ||
		event?.type !== "cache_keep_alive_settings_changed" ||
		event.sequence !== sequence ||
		JSON.stringify(event.settings) !== JSON.stringify(settings)
	) {
		throw new Error(
			`unexpected cache keep-alive event: ${JSON.stringify(batch)}`,
		);
	}
}

async function run() {
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	try {
		const initial = await pilo.bootstrap();
		const saved = expectPolicy(
			await pilo.saveCacheKeepAliveSettings(policy),
			policy,
			0,
		);
		await expectSettingsEvent(pilo, initial.eventSequence + 1, saved);

		for (const invalid of [
			{ cacheTtlSeconds: 9 },
			{ idleKeepAliveSeconds: 59 },
			{ provider: " " },
			{ modelId: "" },
		]) {
			await expectError(
				pilo.saveCacheKeepAliveSettings({ ...policy, ...invalid }),
				"invalid cache keep-alive settings",
			);
		}
		await expectError(
			pilo.saveCacheKeepAliveSettings({ ...policy, connectionId: "missing" }),
			"Connection 'missing' was not found",
		);
		expectPolicyList(await pilo.loadCacheKeepAliveSettings("local"), saved);

		const changed = { ...policy, enabled: false, cacheTtlSeconds: 600 };
		const updated = expectPolicy(
			await pilo.saveCacheKeepAliveSettings({ ...changed, updatedAtMs: 1 }),
			changed,
			saved.updatedAtMs,
		);
		await expectSettingsEvent(pilo, initial.eventSequence + 2, updated);
		await pilo.shutdown();
		await expectError(
			pilo.saveCacheKeepAliveSettings(policy),
			"Pilo runtime has been shut down",
		);
		const reopened = new Pilo(fixture.dataDir());
		try {
			expectPolicyList(
				await reopened.loadCacheKeepAliveSettings("local"),
				updated,
			);
		} finally {
			await reopened.shutdown();
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("cache keep-alive policy saves verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
