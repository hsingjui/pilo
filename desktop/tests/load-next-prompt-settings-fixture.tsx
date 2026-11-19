import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

const status = signal("loading next-prompt settings");

type Settings = {
	connectionId: string;
	enabled: boolean;
	model: { provider: string; id: string } | null;
	updatedAtMs: number;
};

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
	try {
		await pilo.listProjects();
		const initial = (await pilo.loadNextPromptSettings("local")) as Settings;
		if (
			initial.connectionId !== "local" ||
			initial.enabled !== false ||
			initial.model !== null ||
			initial.updatedAtMs !== 0
		) {
			throw new Error(`unexpected defaults: ${JSON.stringify(initial)}`);
		}
		fixture.seedNextPromptSettings();
		const stored = (await pilo.loadNextPromptSettings("local")) as Settings;
		if (
			stored.connectionId !== "local" ||
			stored.enabled !== true ||
			stored.model?.provider !== "fixture" ||
			stored.model.id !== "prediction" ||
			stored.updatedAtMs !== 123
		) {
			throw new Error(`unexpected saved settings: ${JSON.stringify(stored)}`);
		}
		await expectError(
			pilo.loadNextPromptSettings("missing"),
			"Connection 'missing' was not found",
		);
		await pilo.shutdown();
		await expectError(
			pilo.loadNextPromptSettings("local"),
			"Pilo runtime has been shut down",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("next-prompt settings loaded");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
