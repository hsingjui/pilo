import { host, mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("loading connection models");
const connectionId = "local";

type Model = {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
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
	const realPi = host.params.realPi === true;
	const fixture = new ChatFixture(realPi);
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		await expectError(
			hostClient.loadConnectionModels("missing"),
			"was not found",
		);
		const models = (await hostClient.loadConnectionModels(
			connectionId,
		)) as Model[];
		if (realPi) {
			if (
				!models.some(
					(model) =>
						model.provider === "relay" && model.id === "deepseek-flash",
				)
			) {
				throw new Error(
					"installed Pi catalog did not include relay/deepseek-flash",
				);
			}
		} else if (
			models.length !== 1 ||
			models[0]?.provider !== "fixture" ||
			models[0]?.id !== "naming" ||
			models[0]?.name !== "Naming Model" ||
			models[0]?.reasoning !== false
		) {
			throw new Error(
				`unexpected connection catalog: ${JSON.stringify(models)}`,
			);
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	await expectError(
		hostClient.loadConnectionModels(connectionId),
		"Pilo runtime has been shut down",
	);
	status.set(
		realPi
			? "installed Pi listed relay/deepseek-flash"
			: "connection models verified",
	);
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
