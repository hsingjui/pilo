import { mount, signal, Text, View } from "nsh";
import { Pilo, SessionFilesFixture } from "app/native";

import type { ConversationReducerContext } from "@/lib/chat/conversation-types";
import { NshPiloClient } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";

const projectId = "session-files";
const sessionKey = "nsh-transcript-history-fixture";
const status = signal("showing a saved chat's settled history");

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
	const messages = [
		{ role: "user", content: "saved question" },
		{
			role: "assistant",
			content: [{ type: "text", text: "saved reply" }],
			stopReason: "stop",
		},
		{ role: "user", content: "second question" },
	];
	const jsonl = messages
		.map((message, index) =>
			JSON.stringify({
				type: "message",
				id: `message-${index}`,
				parentId: index === 0 ? null : `message-${index - 1}`,
				timestamp: "2025-01-02T03:04:05.000Z",
				message,
			}),
		)
		.join("\n");
	const fixture = new SessionFilesFixture(`${jsonl}\n`);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	let snapshots = 0;
	const chat = new ChatTranscriptStore(
		{
			chatState: (key) => client.chatState(key),
			chatTranscriptSnapshot(key, window) {
				snapshots += 1;
				return client.chatTranscriptSnapshot(key, window);
			},
			loadHistory: (project, path, options) =>
				client.loadHistory(project, path, options),
		},
		context(),
	);
	const app = new AppStore(client, chat);
	const sessionPath = fixture.sessionPath();
	const texts = () =>
		chat.state().conversation?.messages.map((message) => message.text);
	const describe = () => JSON.stringify({ ...chat.state(), snapshots });
	try {
		await app.start();

		// A saved chat with no Pi shows its settled history.
		await chat.open({ sessionKey, projectId, sessionPath }, app.connected);
		assert(
			chat.state().status === "ready" &&
				chat.state().source === "history" &&
				JSON.stringify(texts()) ===
					JSON.stringify(["saved question", "saved reply", "second question"]),
			`unexpected settled history: ${describe()}`,
		);

		// Opened with a window, only that part of the session is read.
		await chat.open({ sessionKey, projectId, sessionPath }, app.connected, {
			messageLimit: 1,
		});
		assert(
			chat.state().status === "ready" &&
				JSON.stringify(texts()) === JSON.stringify(["second question"]),
			`unexpected history window: ${describe()}`,
		);

		// A session file that is gone fails the chat with the runtime's reason.
		await chat.open(
			{
				sessionKey,
				projectId,
				sessionPath: sessionPath.replace(/fixture\.jsonl$/, "missing.jsonl"),
			},
			app.connected,
		);
		assert(
			chat.state().status === "failed" &&
				chat.state().conversation === null &&
				chat.state().message?.includes("No such file or directory") === true,
			`unexpected state for a missing session file: ${describe()}`,
		);

		// None of it asked for a snapshot or started Pi.
		assert(
			snapshots === 0 &&
				(await client.chatState(sessionKey)) === null &&
				(await client.bootstrap()).chatSessions.length === 0,
			`reading settled history started a chat: ${describe()}`,
		);
	} finally {
		app.stop();
		await client.shutdown();
		fixture.dispose();
	}
	status.set("settled history shown through the store");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
