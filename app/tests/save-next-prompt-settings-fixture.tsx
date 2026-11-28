import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("saving next-prompt settings");
const model = { provider: "fixture", id: "prediction" };

type Settings = {
	connectionId: string;
	enabled: boolean;
	model: typeof model | null;
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

function expectSnapshot(actual: unknown, expected: Settings) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`unexpected next-prompt settings: ${JSON.stringify(actual)}`,
		);
	}
}

async function save(
	pilo: Pilo,
	enabled: boolean,
	selected: typeof model | null,
	previousRevision: number,
	sequence: number,
) {
	const hostClient = createNativeHostClient(pilo);
	const saved = (await hostClient.saveNextPromptSettings(
		"local",
		enabled,
		selected,
	)) as Settings;
	if (
		saved.connectionId !== "local" ||
		saved.enabled !== enabled ||
		(selected
			? saved.model?.provider !== selected.provider ||
				saved.model?.id !== selected.id
			: saved.model !== null) ||
		!(saved.updatedAtMs > previousRevision)
	) {
		throw new Error(`unexpected save result: ${JSON.stringify(saved)}`);
	}
	const batch = (await pilo.nextEvents(1)) as {
		type: string;
		events?: { type: string; sequence: number; settings: Settings }[];
	};
	const event = batch.events?.[0];
	if (
		batch.type !== "events" ||
		event?.type !== "next_prompt_settings_changed" ||
		event.sequence !== sequence
	) {
		throw new Error(`unexpected next-prompt event: ${JSON.stringify(batch)}`);
	}
	expectSnapshot(event.settings, saved);
	return saved;
}

async function run() {
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const { latestSequence: eventSequence } = await hostClient.bootstrap();
		const enabled = await save(pilo, true, model, 0, eventSequence + 1);
		await expectError(
			hostClient.saveNextPromptSettings("local", true, { ...model, id: " " }),
			"prediction model provider and id must be nonempty and within limits",
		);
		await expectError(
			hostClient.saveNextPromptSettings("local", true, {
				provider: "fixture",
			} as never),
			"missing field",
		);
		await expectError(
			hostClient.saveNextPromptSettings("missing", false, null),
			"Connection 'missing' was not found",
		);
		expectSnapshot(await hostClient.loadNextPromptSettings("local"), enabled);
		const disabled = await save(
			pilo,
			false,
			model,
			enabled.updatedAtMs,
			eventSequence + 2,
		);
		const inherited = await save(
			pilo,
			true,
			null,
			disabled.updatedAtMs,
			eventSequence + 3,
		);

		await pilo.shutdown();
		await expectError(
			hostClient.saveNextPromptSettings("local", false, null),
			"Pilo runtime has been shut down",
		);
		const reopened = new Pilo(fixture.dataDir());
		const reopenedClient = createNativeHostClient(reopened);
		try {
			expectSnapshot(
				await reopenedClient.loadNextPromptSettings("local"),
				inherited,
			);
		} finally {
			await reopened.shutdown();
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("next-prompt settings saves verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
