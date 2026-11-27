import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const fixture = new BootstrapFixture();
const status = signal("bootstrapping");

async function run() {
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	const {
		projects,
		chatSessions,
		latestSequence: eventSequence,
		preferences,
	} = await hostClient.bootstrap();
	const hasDefaultWorkspace = projects.some(
		(project) =>
			(project as { connection?: { id?: string } }).connection?.id === "local",
	);
	if (!hasDefaultWorkspace || chatSessions.length !== 0) {
		throw new Error("unexpected bootstrap snapshot");
	}
	if (eventSequence !== 0 || preferences.revision !== 0) {
		throw new Error("unexpected initial event sequence or preference revision");
	}
	const patched = await hostClient.savePreferences({ locale: "zh-CN" });
	const next = await hostClient.bootstrap();
	if (
		next.latestSequence <= eventSequence ||
		next.preferences.revision !== patched.revision ||
		JSON.stringify(next.preferences.values) !== JSON.stringify(patched.values)
	) {
		throw new Error(
			"bootstrap did not include the preference change and its event cut",
		);
	}
	await Promise.all([pilo.shutdown(), pilo.shutdown()]);
	try {
		await hostClient.bootstrap();
	} catch (error) {
		status.set(
			`workspace and chat snapshots loaded; ${(error as Error).message}`,
		);
		return;
	}
	throw new Error("bootstrap unexpectedly succeeded after shutdown");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
