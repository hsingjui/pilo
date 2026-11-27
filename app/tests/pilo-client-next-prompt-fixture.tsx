import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { NextPromptSettings } from "@shared/next-prompt-types";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("loading next-prompt settings through the client");

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

function sameSettings(a: NextPromptSettings, b: NextPromptSettings) {
	return (
		a.connectionId === b.connectionId &&
		a.enabled === b.enabled &&
		a.model?.provider === b.model?.provider &&
		a.model?.id === b.model?.id &&
		a.updatedAtMs === b.updatedAtMs
	);
}

async function run() {
	const fixture = new BootstrapFixture();
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
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
		const initial = await client.loadNextPromptSettings("local");
		assert(
			sameSettings(initial, {
				connectionId: "local",
				enabled: false,
				model: null,
				updatedAtMs: 0,
			}),
			`unexpected unsaved settings: ${JSON.stringify(initial)}`,
		);
		await expectError(
			client.loadNextPromptSettings("missing"),
			"Connection 'missing' was not found",
		);

		const model = { provider: "fixture", id: "prediction" };
		const enabled = await client.saveNextPromptSettings("local", true, model);
		assert(
			enabled.connectionId === "local" &&
				enabled.enabled &&
				enabled.model?.provider === model.provider &&
				enabled.model.id === model.id &&
				enabled.updatedAtMs > 0,
			`unexpected saved settings: ${JSON.stringify(enabled)}`,
		);
		// The save also reaches listeners as an event carrying the settings.
		while (received.length === 0) {
			await new Promise<void>((resolve) => (wake = resolve));
		}
		const [event] = received;
		assert(
			event?.type === "next_prompt_settings_changed" &&
				sameSettings(event.settings, enabled),
			`unexpected settings event: ${JSON.stringify(event)}`,
		);
		assert(
			sameSettings(await client.loadNextPromptSettings("local"), enabled),
			"the loaded settings differ from the saved ones",
		);

		await expectError(
			client.saveNextPromptSettings("local", true, { ...model, id: " " }),
			"prediction model provider and id must be nonempty",
		);
		await expectError(
			client.saveNextPromptSettings("missing", false, null),
			"Connection 'missing' was not found",
		);

		// A null model follows the chat's model.
		const following = await client.saveNextPromptSettings("local", false, null);
		assert(
			!following.enabled &&
				following.model === null &&
				following.updatedAtMs > enabled.updatedAtMs,
			`unexpected settings without a model: ${JSON.stringify(following)}`,
		);
		assert(
			sameSettings(await client.loadNextPromptSettings("local"), following),
			"the settings did not go back to following the chat model",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.loadNextPromptSettings("local"),
		"Pilo runtime has been shut down",
	);
	status.set("client next-prompt settings verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
