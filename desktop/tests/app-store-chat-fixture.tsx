import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import { NshPiloClient } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";

const projectId = "chat-fixture";
const sessionKey = "nsh-app-store-chat-fixture";
const status = signal("following chat states through the store");

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

async function run() {
	const fixture = new ChatFixture(false);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	const store = new AppStore(client);
	const held = () =>
		store.state().chatSessions.find((chat) => chat.sessionKey === sessionKey);
	const until = async (done: () => boolean, what: string) => {
		const deadline = Date.now() + 10_000;
		while (!done()) {
			if (Date.now() > deadline) {
				throw new Error(
					`${what} never happened: ${JSON.stringify(store.state().chatSessions)}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	try {
		await store.start();
		assert(
			store.state().status.type === "ready" &&
				store.state().chatSessions.length === 0,
			"the app did not start with no chats",
		);

		// A chat started after launch appears as running, with no turn.
		const sessionPath = fixture.seedTranscript(
			`${JSON.stringify({
				type: "message",
				id: "prior-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "saved question" },
			})}\n`,
		);
		await client.startChat({ projectId, sessionKey, sessionPath });
		await until(
			() => held()?.snapshot.state === "running",
			"the started chat appearing as running",
		);
		assert(
			held()?.projectId === projectId && held()?.activeTurn === false,
			`unexpected state of the started chat: ${JSON.stringify(held())}`,
		);

		// The fixture's stand-in for Pi leaves a turn open on this command id.
		await client.sendChatCommand(sessionKey, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
		await until(() => held()?.activeTurn === true, "the chat's turn starting");

		// What the store holds is what the runtime reports.
		const reported = await client.chatState(sessionKey);
		assert(
			JSON.stringify(held()) === JSON.stringify(reported),
			`the store differs from the runtime: ${JSON.stringify(reported)}`,
		);

		await client.stopChat(sessionKey);
		await until(() => held() === undefined, "the stopped chat going away");
	} finally {
		store.stop();
		await client.shutdown();
		fixture.dispose();
	}
	status.set("chat states followed through the store");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
