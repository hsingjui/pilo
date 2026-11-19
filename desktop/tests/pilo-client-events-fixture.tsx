import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

import type { PiloClientEventMessage } from "@/lib/api/pilo-client";
import { NshPiloClient } from "../client/nsh-pilo-client";

/** More events than the native queue's 2,048, even after one batch is taken. */
const OVERFLOWING_SAVES = 2_400;

const fixture = new BootstrapFixture();
const status = signal("waiting for runtime events through the client");

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

function listen(client: NshPiloClient) {
	const messages: PiloClientEventMessage[] = [];
	const statuses: boolean[] = [];
	let wake = () => {};
	const connected = client.connectEvents({
		onMessage: (message) => {
			messages.push(message);
			wake();
		},
		onStatus: (isConnected) => {
			statuses.push(isConnected);
			wake();
		},
	});
	const until = async (done: () => boolean) => {
		while (!done()) await new Promise<void>((resolve) => (wake = resolve));
	};
	const sequences = () =>
		messages.flatMap((message) =>
			message.type === "events"
				? message.events.map((event) => event.sequence)
				: [],
		);
	return { connected, messages, statuses, sequences, until };
}

async function run() {
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	try {
		const { latestSequence } = await client.bootstrap();
		const live = listen(client);
		const disconnect = await live.connected;
		const first = await client.savePreferences({ locale: "zh-CN" });
		const second = await client.savePreferences({ locale: "en-US" });
		await live.until(() => live.sequences().length === 2);
		const delivered = live.messages.flatMap((message) =>
			message.type === "events" ? message.events : [],
		);
		assert(
			JSON.stringify(live.sequences()) ===
				JSON.stringify([latestSequence + 1, latestSequence + 2]) &&
				delivered.every(
					(event, index) =>
						event.type === "preferences_changed" &&
						event.settings.revision === [first, second][index]?.revision,
				) &&
				JSON.stringify(live.statuses) === "[true]",
			`unexpected live events: ${JSON.stringify(live.messages)}`,
		);
		disconnect();

		for (let save = 0; save < OVERFLOWING_SAVES; save += 1) {
			await client.savePreferences({
				locale: save % 2 === 0 ? "zh-CN" : "en-US",
			});
		}
		const resumed = listen(client);
		await resumed.connected;
		await resumed.until(() =>
			resumed.messages.some((message) => message.type === "resyncRequired"),
		);
		const lastSequence = (await client.bootstrap()).latestSequence;
		assert(
			lastSequence === latestSequence + 2 + OVERFLOWING_SAVES,
			"bootstrap after the gap did not carry the latest event cut",
		);
		await resumed.until(() => resumed.sequences().at(-1) === lastSequence);
		let expected = latestSequence + 3;
		let resyncs = 0;
		for (const message of resumed.messages) {
			if (message.type === "resyncRequired") {
				assert(
					message.latestSequence >= expected,
					`resync did not name a dropped sequence: ${JSON.stringify(message)}`,
				);
				expected = message.latestSequence + 1;
				resyncs += 1;
			} else if (message.type === "events") {
				for (const event of message.events) {
					assert(
						event.sequence === expected,
						`event ${event.sequence} arrived where ${expected} was due`,
					);
					expected += 1;
				}
			}
		}
		assert(
			resyncs === 1 && expected === lastSequence + 1,
			`expected one resync and every later event, got ${resyncs} resyncs up to ${expected - 1}`,
		);

		await client.shutdown();
		await resumed.until(() => resumed.statuses.includes(false));
		assert(
			JSON.stringify(resumed.statuses) === "[true,false]" &&
				JSON.stringify(live.statuses) === "[true,false]",
			"listeners were not disconnected exactly once",
		);
		const late = listen(client);
		await late.connected;
		assert(
			JSON.stringify(late.statuses) === "[false]" && late.messages.length === 0,
			"a listener connected after shutdown was not told it is disconnected",
		);
	} finally {
		await client.shutdown();
	}
	status.set("client event delivery, gap resync and shutdown verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
