import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const fixture = new BootstrapFixture();
const status = signal("waiting for runtime events");

type PreferenceEvent = {
	sequence: number;
	type: string;
	settings: { revision: number; values: { locale: string } };
};

async function expectInvalidBatchSize(pilo: Pilo, max: number) {
	try {
		await pilo.nextEvents(max);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("event batch size must be a positive safe integer")
		) {
			return;
		}
		throw error;
	}
	throw new Error(`batch size unexpectedly accepted: ${max}`);
}

function expectPreferenceEvent(
	value: unknown,
	sequence: number,
	revision: number,
	locale: string,
) {
	const batch = value as { type: string; events: PreferenceEvent[] };
	const event = batch.events?.[0];
	if (
		batch.type !== "events" ||
		batch.events.length !== 1 ||
		!event ||
		event.sequence !== sequence ||
		event.type !== "preferences_changed" ||
		event.settings.revision !== revision ||
		event.settings.values.locale !== locale
	) {
		throw new Error(`unexpected event batch: ${JSON.stringify(value)}`);
	}
}

function expectClosed(batch: unknown) {
	if ((batch as { type: string }).type !== "closed") {
		throw new Error(`expected a closed event stream: ${JSON.stringify(batch)}`);
	}
}

async function run() {
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const initial = await hostClient.bootstrap();
		for (const max of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			await expectInvalidBatchSize(pilo, max);
		}
		const first = await hostClient.savePreferences({ locale: "zh-CN" });
		const second = await hostClient.savePreferences({ locale: "en-US" });
		expectPreferenceEvent(
			await pilo.nextEvents(1),
			initial.latestSequence + 1,
			first.revision,
			"zh-CN",
		);
		expectPreferenceEvent(
			await pilo.nextEvents(1),
			initial.latestSequence + 2,
			second.revision,
			"en-US",
		);

		let settled = false;
		const pending = pilo.nextEvents(1).then((batch) => {
			settled = true;
			return batch;
		});
		await hostClient.bootstrap();
		if (settled) throw new Error("empty event stream did not wait");
		const [closed] = await Promise.all([pending, pilo.shutdown()]);
		expectClosed(closed);
		expectClosed(await pilo.nextEvents(1));
	} finally {
		await pilo.shutdown();
	}
	status.set("ordered runtime batches and shutdown closure verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
