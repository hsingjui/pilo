import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const fixture = new BootstrapFixture();
const status = signal("loading preferences");

type Values = {
	locale: string;
	uiFontSize: number;
	defaultWorkspaceVisibility: Record<string, boolean>;
};

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

async function run() {
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	const initial = await hostClient.loadPreferences();
	assert(initial.revision === 0, "expected a fresh revision");
	assert((initial.values as Values).locale === "en-US", "expected defaults");

	const first = await hostClient.savePreferences({
		locale: "zh-CN",
		defaultWorkspaceVisibility: { local: false },
	});
	const second = await hostClient.savePreferences({
		uiFontSize: 17,
		defaultWorkspaceVisibility: { remote: true },
	});
	const values = second.values as Values;
	assert(second.revision === first.revision + 1, "expected a new revision");
	assert(
		values.locale === "zh-CN" &&
			values.uiFontSize === 17 &&
			values.defaultWorkspaceVisibility.local === false &&
			values.defaultWorkspaceVisibility.remote === true,
		"partial patches did not preserve unrelated preference values",
	);
	await expectError(
		hostClient.savePreferences([] as never),
		"invalid type: sequence, expected a map",
	);
	await expectError(
		hostClient.savePreferences({ locale: "en-US", uiFontSize: -1 }),
		"invalid preference 'uiFontSize'",
	);
	await pilo.shutdown();
	await expectError(
		hostClient.loadPreferences(),
		"Pilo runtime has been shut down",
	);
	await expectError(
		hostClient.savePreferences({ locale: "en-US" }),
		"Pilo runtime has been shut down",
	);

	const reopened = new Pilo(fixture.dataDir());
	const reopenedClient = createNativeHostClient(reopened);
	try {
		const persisted = await reopenedClient.loadPreferences();
		assert(
			persisted.revision === second.revision &&
				JSON.stringify(persisted.values) === JSON.stringify(second.values),
			"valid patches did not persist or an invalid patch changed the row",
		);
	} finally {
		await reopened.shutdown();
	}
	status.set("preferences patched, validated, and persisted");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
