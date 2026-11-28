import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("saving a policy with a running chat");
const sessionKey = "cache-keep-alive-running";
const policy = {
	connectionId: "local",
	provider: "fixture",
	modelId: "naming",
	enabled: true,
	cacheTtlSeconds: 300,
	idleKeepAliveSeconds: 1800,
};
type Event = {
	type: string;
	sessionKey?: string;
	message?: { id?: string; success?: boolean; data?: unknown };
	settings?: unknown;
};

async function waitForEvent(pilo: Pilo, matches: (event: Event) => boolean) {
	for (;;) {
		const batch = (await pilo.nextEvents(1)) as {
			type: string;
			events?: Event[];
		};
		if (batch.type !== "events")
			throw new Error(`unexpected batch: ${batch.type}`);
		const event = batch.events?.[0];
		if (event && matches(event)) return event;
	}
}

async function run() {
	const fixture = new ChatFixture(false);
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const started = (await hostClient.startChat({
			projectId: "chat-fixture",
			sessionKey,
			noSession: true,
		})) as { generation: number; state: string };
		if (started.state !== "running")
			throw new Error("fixture chat did not start");
		await hostClient.sendChatCommand(sessionKey, {
			id: "fixture-cache-model",
			type: "set_model",
			provider: policy.provider,
			modelId: policy.modelId,
		});
		const model = await waitForEvent(
			pilo,
			(event) =>
				event.sessionKey === sessionKey &&
				event.type === "rpc_message" &&
				event.message?.id === "fixture-cache-model",
		);
		if (model.message?.success !== true)
			throw new Error("fixture model was not set");

		const saved = (await hostClient.saveCacheKeepAliveSettings(
			policy as never,
		)) as typeof policy & {
			updatedAtMs: number;
		};
		const changed = await waitForEvent(
			pilo,
			(event) => event.type === "cache_keep_alive_settings_changed",
		);
		if (
			saved.connectionId !== policy.connectionId ||
			saved.provider !== policy.provider ||
			saved.modelId !== policy.modelId ||
			saved.enabled !== true ||
			!(saved.updatedAtMs > 0) ||
			JSON.stringify(changed.settings) !== JSON.stringify(saved)
		) {
			throw new Error(
				"the save and change event did not carry the expected policy",
			);
		}
		const state = (await hostClient.chatState(sessionKey)) as {
			snapshot: { generation: number; state: string };
		} | null;
		if (
			state?.snapshot.state !== "running" ||
			state.snapshot.generation !== started.generation
		) {
			throw new Error(
				"the original chat process was not running after the save",
			);
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("cache keep-alive saved while chat stayed running");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
