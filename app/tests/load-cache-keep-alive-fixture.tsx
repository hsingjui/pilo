import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("loading cache keep-alive policies");

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

async function run() {
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		await hostClient.listProjects();
		const initial = await hostClient.loadCacheKeepAliveSettings("local");
		if (!Array.isArray(initial) || initial.length !== 0) {
			throw new Error("expected an empty set of local policies");
		}

		fixture.seedCacheKeepAliveSettings();
		const policies = (await hostClient.loadCacheKeepAliveSettings("local")) as {
			connectionId: string;
			provider: string;
			modelId: string;
			enabled: boolean;
			cacheTtlSeconds: number;
			idleKeepAliveSeconds: number;
			updatedAtMs: number;
		}[];
		const [first, second] = policies;
		if (
			policies.length !== 2 ||
			first?.connectionId !== "local" ||
			first.provider !== "fixture" ||
			first.modelId !== "first" ||
			first.enabled !== true ||
			first.cacheTtlSeconds !== 300 ||
			first.idleKeepAliveSeconds !== 1800 ||
			first.updatedAtMs !== 123 ||
			second?.modelId !== "second" ||
			second.enabled !== false
		) {
			throw new Error(
				`unexpected cache keep-alive policies: ${JSON.stringify(policies)}`,
			);
		}
		await expectError(
			hostClient.loadCacheKeepAliveSettings("missing"),
			"Connection 'missing' was not found",
		);
		await pilo.shutdown();
		await expectError(
			hostClient.loadCacheKeepAliveSettings("local"),
			"Pilo runtime has been shut down",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("cache keep-alive policies loaded");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
