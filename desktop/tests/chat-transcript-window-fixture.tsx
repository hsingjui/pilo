import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@/lib/api/pilo-client";
import type { ConversationReducerContext } from "@/lib/chat/conversation-types";
import { NshPiloClient } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";

const projectId = "chat-fixture";
const sessionKey = "nsh-transcript-window-fixture";
const turns = 5_000;
const status = signal("showing the last messages of a long session");

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

/** A session of `turns` turns, each a question, a tool call and a reply. */
function longSession() {
	const lines: string[] = [];
	const add = (message: object) => {
		const at = lines.length;
		lines.push(
			JSON.stringify({
				type: "message",
				id: `entry-${at}`,
				parentId: at === 0 ? null : `entry-${at - 1}`,
				timestamp: new Date(1_750_000_000_000 + at * 1000).toISOString(),
				message,
			}),
		);
	};
	for (let turn = 0; turn < turns; turn += 1) {
		add({ role: "user", content: `question ${turn}` });
		add({
			role: "assistant",
			content: [
				{ type: "text", text: `looking at file ${turn}` },
				{
					type: "toolCall",
					id: `call-${turn}`,
					name: "read",
					arguments: { path: `src/file-${turn}.ts` },
				},
			],
			stopReason: "toolUse",
		});
		add({
			role: "toolResult",
			toolCallId: `call-${turn}`,
			toolName: "read",
			content: [{ type: "text", text: `contents of file ${turn}` }],
		});
		add({
			role: "assistant",
			content: [{ type: "text", text: `reply ${turn} ${"word ".repeat(60)}` }],
			stopReason: "stop",
		});
	}
	return `${lines.join("\n")}\n`;
}

const elapsed = (since: number) =>
	Math.round((performance.now() - since) * 100) / 100;

async function run() {
	const fixture = new ChatFixture(false);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	/** How many saved messages each read of the store returned to replay. */
	const reads: (number | undefined)[] = [];
	const chat = new ChatTranscriptStore(
		{
			chatState: (key) => client.chatState(key),
			async chatTranscriptSnapshot(key, window) {
				const snapshot = await client.chatTranscriptSnapshot(key, window);
				reads.push(snapshot.history.history.windowMessageCount);
				return snapshot;
			},
			async loadHistory(project, path, options) {
				const result = await client.loadHistory(project, path, options);
				reads.push(result.history.windowMessageCount);
				return result;
			},
		},
		context(),
	);
	const app = new AppStore(client, chat);
	const describe = () => {
		const { conversation, historyPrefix, ...rest } = chat.state();
		return JSON.stringify({
			...rest,
			loaded: conversation?.messages.length,
			before: historyPrefix.length,
		});
	};
	try {
		const jsonl = longSession();
		const sessionPath = fixture.seedTranscript(jsonl);
		await app.start();

		// With no Pi, the session's last messages are loaded and the ones
		// before them are placeholders from its index.
		let since = performance.now();
		await chat.open({ sessionKey, projectId, sessionPath }, app.connected);
		const cold = elapsed(since);
		const { history } = await client.loadHistory(projectId, sessionPath, {
			messageLimit: 1,
			includeMessageIndex: true,
		});
		const index = history.messageIndex ?? [];
		const loaded = chat.state().conversation?.messages ?? [];
		const start = chat.state().historyPrefix.length;
		assert(
			chat.state().status === "ready" &&
				chat.state().source === "history" &&
				index.length === 2 * turns &&
				loaded.length === 80 &&
				start === index.length - 80,
			`unexpected window of a long session: ${describe()}, ${index.length} indexed`,
		);

		// Loaded or not, a message has its index entry's id and role, so a row
		// keyed by the id stays the same row when its message is loaded.
		const differs = chat
			.messages()
			.findIndex(
				(message, at) =>
					message.id !== index[at]?.id || message.role !== index[at]?.role,
			);
		assert(
			chat.messages().length === index.length && differs === -1,
			`message ${differs} differs from its index entry: ${JSON.stringify([
				chat.messages()[differs],
				index[differs],
			])}`,
		);
		assert(
			new Set(index.map(({ id }) => id)).size === index.length,
			"the session's index has an id twice",
		);
		const placeholder = chat.state().historyPrefix[start - 1];
		assert(
			placeholder?.historyPlaceholder === true &&
				placeholder.role === "assistant" &&
				placeholder.text.includes(`reply ${turns - 41} word`) &&
				(placeholder.historyEstimatedChars ?? 0) > 300 &&
				loaded[0]?.historyPlaceholder === undefined &&
				loaded[0]?.text === `question ${turns - 40}` &&
				loaded[1]?.role === "assistant" &&
				loaded[1].text.includes(`reply ${turns - 40} word`),
			`unexpected messages at the seam: ${JSON.stringify([placeholder, loaded[0]])}`,
		);

		since = performance.now();
		await chat.open({ sessionKey, projectId, sessionPath }, app.connected);
		const warm = elapsed(since);

		// With Pi running a turn, the snapshot has the same window and index.
		await client.startChat({ projectId, sessionKey, sessionPath });
		await client.sendChatCommand(sessionKey, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
		const deadline = Date.now() + 10_000;
		while (
			chat.state().source !== "snapshot" ||
			!chat.state().conversation?.active
		) {
			if (Date.now() > deadline) {
				throw new Error(`the turn never streamed: ${describe()}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const prefix = chat.state().historyPrefix;
		const running = chat.state().conversation?.messages ?? [];
		assert(
			prefix.length === start &&
				prefix[start - 1]?.id === index[start - 1]?.id &&
				running[0]?.id === index[start]?.id &&
				running[79]?.id === index[index.length - 1]?.id &&
				running.at(-2)?.text === "new question" &&
				running.at(-1)?.role === "assistant",
			`unexpected window of the running chat: ${describe()}`,
		);

		// More of the reply changes the conversation only: the placeholders
		// are the same array, so an event costs the same in any session.
		const reply = running.at(-1)?.text ?? "";
		const generation = (await client.chatState(sessionKey))?.snapshot
			.generation;
		const delta = (at: number) =>
			({
				type: "assistant_text_delta",
				sessionKey,
				projectId,
				generation,
				delta: " more",
				sequence: Number.MAX_SAFE_INTEGER - 2_000 + at,
			}) as PiloClientEvent;
		since = performance.now();
		for (let at = 0; at < 1_000; at += 1) chat.receive([delta(at)]);
		const perEvent = elapsed(since) / 1_000;
		assert(
			chat.state().historyPrefix === prefix &&
				chat.state().conversation?.messages.at(-1)?.text ===
					reply + " more".repeat(1_000),
			`the streamed text was not applied as expected: ${describe()}`,
		);
		since = performance.now();
		for (let at = 1_000; at < 2_000; at += 1) {
			chat.receive([delta(at)]);
			chat.messages();
		}
		const perEventJoined = elapsed(since) / 1_000;
		assert(
			chat.messages().length === index.length + 2 &&
				chat.messages()[0] === prefix[0] &&
				chat.messages() === chat.messages(),
			`unexpected joined messages: ${chat.messages().length}`,
		);
		// Joining copies the 9,920 placeholders, about twenty times the cost
		// of the event itself, so it must not happen unless it is read.
		assert(
			perEvent * 2 < perEventJoined,
			`an event costs ${perEvent} ms, and ${perEventJoined} ms with the join`,
		);
		// No read of the store returned more than its window to replay: the
		// rest of the session is never replayed, only shown from the index.
		assert(
			reads.length >= 3 && reads.every((messages) => messages === 80),
			`unexpected reads of a long session: ${JSON.stringify(reads)}`,
		);
		console.log(
			`[transcript-window] ${JSON.stringify({
				sessionBytes: jsonl.length,
				messages: index.length,
				replayedPerRead: reads,
				openColdMs: cold,
				openWarmMs: warm,
				streamedEventMs: perEvent,
				streamedEventWithJoinMs: perEventJoined,
			})}`,
		);
		await client.stopChat(sessionKey);
	} finally {
		app.stop();
		await client.shutdown();
		fixture.dispose();
	}
	status.set("long session shown through the store");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
