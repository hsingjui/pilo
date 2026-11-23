import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { ConversationReducerContext } from "@shared/chat/conversation-types";
import { NshPiloClient } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";

const projectId = "chat-fixture";
const savedKey = "nsh-transcript-store-fixture";
const unsavedKey = `${savedKey}-unsaved`;
const status = signal("following a chat transcript through the store");

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => Date.now(),
		formatTime: () => "",
	};
}

async function run() {
	const fixture = new ChatFixture(false);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	let snapshots = 0;
	let histories = 0;
	const chat = new ChatTranscriptStore(
		{
			chatState: (sessionKey) => client.chatState(sessionKey),
			chatTranscriptSnapshot(sessionKey, window) {
				snapshots += 1;
				return client.chatTranscriptSnapshot(sessionKey, window);
			},
			loadHistory(project, sessionPath, options) {
				histories += 1;
				return client.loadHistory(project, sessionPath, options);
			},
		},
		context(),
	);
	const app = new AppStore(client, chat);
	const texts = () =>
		chat.state().conversation?.messages.map((message) => message.text);
	const shows = (...expected: string[]) =>
		JSON.stringify(texts()) === JSON.stringify(expected);
	const describe = () =>
		JSON.stringify({ ...chat.state(), snapshots, histories });
	// A second listener, to know what the runtime has sent so far.
	const received: PiloClientEvent[] = [];
	let wake = () => {};
	const until = async (done: () => boolean, what: string) => {
		const deadline = Date.now() + 10_000;
		while (!done()) {
			if (Date.now() > deadline) {
				throw new Error(`${what} never happened: ${describe()}`);
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 20);
			});
		}
	};
	const prompt = (sessionKey: string) =>
		// The fixture's stand-in for Pi leaves a turn open on this command id.
		client.sendChatCommand(sessionKey, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
	try {
		await app.start();
		assert(app.state().status.type === "ready", "the app did not start");
		await client.connectEvents({
			onMessage: (message) => {
				if (message.type === "events") received.push(...message.events);
				wake();
			},
			onStatus: () => wake(),
		});

		// A chat with no Pi and no session file is empty, and opening it
		// starts none.
		await chat.open({ sessionKey: unsavedKey, projectId }, app.connected);
		assert(
			chat.state().status === "ready" &&
				chat.state().source === "history" &&
				chat.state().conversation?.messages.length === 0 &&
				snapshots === 0 &&
				histories === 0 &&
				(await client.chatState(unsavedKey)) === null,
			`unexpected state for a new chat with no Pi: ${describe()}`,
		);

		// A saved chat with no Pi shows its settled history, and opening it
		// starts none.
		const sessionPath = fixture.seedTranscript(
			`${JSON.stringify({
				type: "message",
				id: "prior-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "saved question" },
			})}\n`,
		);
		await chat.open(
			{ sessionKey: savedKey, projectId, sessionPath },
			app.connected,
		);
		assert(
			chat.state().status === "ready" &&
				chat.state().source === "history" &&
				shows("saved question") &&
				snapshots === 0 &&
				histories === 1 &&
				(await client.chatState(savedKey)) === null,
			`unexpected state for a saved chat with no Pi: ${describe()}`,
		);

		// Starting Pi and sending a prompt, as the first message does, moves
		// the transcript onto a snapshot without it being opened again, so
		// the turn streams.
		await client.startChat({ projectId, sessionKey: savedKey, sessionPath });
		await prompt(savedKey);
		await until(
			() =>
				chat.state().status === "ready" &&
				chat.state().source === "snapshot" &&
				shows("saved question", "new question", "partial reply"),
			"the started chat's transcript with its running turn",
		);
		const reply = chat.state().conversation?.messages.at(-1);
		assert(
			snapshots === 1 &&
				histories === 1 &&
				chat.state().conversation?.active !== null &&
				reply?.role === "assistant" &&
				reply.streaming === true,
			`the turn was not shown as running: ${describe()}`,
		);

		// Read again mid-turn, the snapshot holds the turn and nothing doubles.
		await chat.refresh();
		assert(
			chat.state().status === "ready" &&
				chat.state().source === "snapshot" &&
				snapshots === 2 &&
				shows("saved question", "new question", "partial reply") &&
				chat.state().conversation?.active !== null,
			`unexpected transcript after a mid-turn read: ${describe()}`,
		);

		// A running turn of an unsaved chat cannot be rebuilt: the store shows
		// nothing for it and waits for the turn to end.
		await client.startChat({
			projectId,
			sessionKey: unsavedKey,
			noSession: true,
		});
		await prompt(unsavedKey);
		await until(
			() =>
				received.some(
					(event) =>
						event.type === "assistant_text_delta" &&
						event.sessionKey === unsavedKey,
				),
			"the unsaved chat's reply",
		);
		await chat.open({ sessionKey: unsavedKey, projectId }, app.connected);
		assert(
			chat.state().status === "loading" &&
				chat.state().conversation === null &&
				snapshots === 3,
			`unexpected state for a truncated snapshot: ${describe()}`,
		);
		// Stopping Pi ends the turn. The one read after it finds no Pi and no
		// session file, so the chat is empty.
		await client.stopChat(unsavedKey);
		await until(
			() => chat.state().status !== "loading",
			"the stopped chat leaving the loading state",
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert(
			chat.state().status === "ready" &&
				chat.state().source === "history" &&
				chat.state().conversation?.messages.length === 0 &&
				snapshots === 3 &&
				histories === 1,
			`unexpected state for a stopped unsaved chat: ${describe()}`,
		);
	} finally {
		app.stop();
		await client.shutdown();
		fixture.dispose();
	}
	status.set("chat transcript followed through the store");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
