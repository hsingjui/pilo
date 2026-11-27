import { mount, signal, Text, View } from "nsh";
import { Pilo, SessionFilesFixture } from "app/native";

import type { ConversationReducerContext } from "@shared/chat/conversation-types";
import { createNativeHostClient } from "../client/native-transport";
import { AppStore } from "../state/app-store";
import { conversationFromHistory } from "../state/chat-transcript";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
// The session file of one real Pi chat (relay/deepseek-flash), entry by
// entry as Pi wrote it: three turns, with one bash tool call, two, and none.
import recordedSession from "./chat-transcript-session-recording.json";

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
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
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

		// A session this short is loaded whole, with nothing before it.
		assert(
			chat.state().historyPrefix.length === 0 &&
				chat.messages() === chat.state().conversation?.messages,
			`unexpected placeholders of a short session: ${describe()}`,
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
				chat.state().message?.endsWith("(os error 2)") === true,
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
	await realSession();
	status.set("settled history shown through the store");
}

/**
 * In a real session with tool calls, a window that starts at any message
 * replays to messages with the ids and roles of the session's index, so a
 * message keeps the id its placeholder had.
 */
async function realSession() {
	const jsonl = recordedSession
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	const fixture = new SessionFilesFixture(`${jsonl}\n`);
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
	const chat = new ChatTranscriptStore(client, context());
	const app = new AppStore(client, chat);
	const sessionPath = fixture.sessionPath();
	try {
		await app.start();
		await chat.open({ sessionKey, projectId, sessionPath }, app.connected);
		const loaded = chat.state().conversation?.messages ?? [];
		const tools = loaded.map((message) =>
			message.role === "assistant"
				? (message.content?.filter((item) => item.type === "tool").length ?? 0)
				: 0,
		);
		assert(
			chat.state().status === "ready" &&
				JSON.stringify(loaded.map(({ role }) => role)) ===
					JSON.stringify([
						"user",
						"assistant",
						"user",
						"assistant",
						"user",
						"assistant",
					]) &&
				JSON.stringify(tools) === JSON.stringify([0, 1, 0, 2, 0, 0]),
			`unexpected real session: ${JSON.stringify(loaded)}`,
		);
		for (let limit = 1; limit <= loaded.length; limit += 1) {
			const { history } = await client.loadHistory(projectId, sessionPath, {
				messageLimit: limit,
				includeMessageIndex: true,
			});
			const index = history.messageIndex ?? [];
			const start = history.windowStartMessage ?? -1;
			const { messages } = conversationFromHistory(history, context());
			assert(
				index.length === loaded.length &&
					start === index.length - limit &&
					messages.length === limit &&
					messages.every(
						(message, offset) =>
							message.id === index[start + offset]?.id &&
							message.role === index[start + offset]?.role &&
							message.id === loaded[start + offset]?.id,
					),
				`a window of ${limit} differs from the index: ${JSON.stringify({
					start,
					messages: messages.map(({ id, role }) => [id, role]),
					index: index.map(({ id, role }) => [id, role]),
				})}`,
			);
		}
	} finally {
		app.stop();
		await client.shutdown();
		fixture.dispose();
	}
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
