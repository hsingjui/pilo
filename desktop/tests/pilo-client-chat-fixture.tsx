import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@/lib/api/pilo-client";
import { NshPiloClient } from "../client/nsh-pilo-client";

const projectId = "chat-fixture";
const sessionKey = "nsh-client-chat-fixture";
const status = signal("driving a Pi chat through the client");

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
	const fixture = new ChatFixture(false);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	const received: PiloClientEvent[] = [];
	let wake = () => {};
	const eventually = async (find: () => boolean) => {
		while (!find()) await new Promise<void>((resolve) => (wake = resolve));
	};
	try {
		await client.connectEvents({
			onMessage: (message) => {
				if (message.type === "events") received.push(...message.events);
				wake();
			},
			onStatus: () => wake(),
		});
		assert(
			(await client.chatState(sessionKey)) === null,
			"a chat that was never started had a state",
		);
		await expectError(
			client.startChat({ projectId: "missing", sessionKey }),
			"Project 'missing' was not found",
		);

		const snapshot = await client.startChat({
			projectId,
			sessionKey,
			noSession: true,
		});
		assert(
			snapshot.state === "running" &&
				snapshot.projectId === projectId &&
				snapshot.generation > 0,
			`Pi did not start: ${JSON.stringify(snapshot)}`,
		);
		const state = await client.chatState(sessionKey);
		assert(
			state?.sessionKey === sessionKey &&
				state.projectId === projectId &&
				state.snapshot.generation === snapshot.generation &&
				!state.activeTurn,
			`unexpected chat state: ${JSON.stringify(state)}`,
		);
		assert(
			(await client.bootstrap()).chatSessions.some(
				(session) => session.sessionKey === sessionKey,
			),
			"the running chat was missing from the bootstrap snapshot",
		);

		// The command's reply arrives on the event stream, not from the call.
		await client.sendChatCommand(sessionKey, {
			id: "client-fixture-state",
			type: "get_state",
		});
		await eventually(() =>
			received.some(
				(event) =>
					event.type === "rpc_message" &&
					event.sessionKey === sessionKey &&
					(event.message as { id?: string }).id === "client-fixture-state",
			),
		);
		assert(
			received.every(
				(event, index) =>
					index === 0 || event.sequence > (received[index - 1]?.sequence ?? 0),
			),
			"chat events did not arrive in sequence order",
		);

		await client.stopChat(sessionKey, "fixture complete");
		await expectError(
			client.sendChatCommand(sessionKey, { type: "get_state" }),
			"is not running",
		);
		await client.stopChat(sessionKey);
		assert(
			(await client.chatState(sessionKey)) === null,
			"the chat state remained after stopping Pi",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.startChat({ projectId, sessionKey }),
		"Pilo runtime has been shut down",
	);
	status.set("client chat lifecycle and command reply verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
