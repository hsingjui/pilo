import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import { sameHistoryFingerprint } from "@shared/chat/chat-history-window-model";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { ConversationReducerContext } from "@shared/chat/conversation-types";
import { createNativeHostClient } from "../client/native-transport";
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

/** A session of `count` turns, each a question, a tool call and a reply. */
function longSession(count = turns) {
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
	for (let turn = 0; turn < count; turn += 1) {
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
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
	/**
	 * Each read the store made: what it was, how many saved messages it
	 * returned to replay, how long the call took, and whether a page came
	 * from a file other than the one it was asked of.
	 */
	const reads: {
		read: "state" | "snapshot" | "history" | "page";
		messages?: number;
		ms: number;
		changed?: boolean;
	}[] = [];
	const chat = new ChatTranscriptStore(
		{
			async chatState(key) {
				const since = performance.now();
				const state = await client.chatState(key);
				reads.push({ read: "state", ms: elapsed(since) });
				return state;
			},
			async chatTranscriptSnapshot(key, window) {
				const since = performance.now();
				const snapshot = await client.chatTranscriptSnapshot(key, window);
				reads.push({
					read: "snapshot",
					messages: snapshot.history.history.windowMessageCount,
					ms: elapsed(since),
				});
				return snapshot;
			},
			async loadHistory(project, path, options) {
				const since = performance.now();
				const result = await client.loadHistory(project, path, options);
				reads.push({
					read: options?.startMessage === undefined ? "history" : "page",
					messages: result.history.windowMessageCount,
					ms: elapsed(since),
					changed:
						options?.fingerprint !== undefined &&
						!sameHistoryFingerprint(options.fingerprint, result.fingerprint),
				});
				return result;
			},
		},
		context(),
	);
	const count = (read: (typeof reads)[number]["read"], changed?: boolean) =>
		reads.filter(
			(entry) =>
				entry.read === read &&
				(changed === undefined || entry.changed === changed),
		).length;
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
		// Where that time went: the runtime's two calls, and the rest in JS
		// (replaying the window and building the placeholders).
		const coldCalls = Object.fromEntries(
			reads.map(({ read, ms }) => [read, ms]),
		);
		const coldJs =
			Math.round((cold - reads.reduce((sum, { ms }) => sum + ms, 0)) * 100) /
			100;
		// The same read again, which the runtime answers from its cache, with
		// and without the session's index: the difference is what the index of
		// 10,000 messages costs to hand over.
		since = performance.now();
		const { history } = await client.loadHistory(projectId, sessionPath, {
			messageLimit: 80,
			includeMessageIndex: true,
		});
		const cachedWithIndex = elapsed(since);
		since = performance.now();
		await client.loadHistory(projectId, sessionPath, {
			messageLimit: 80,
			includeMessageIndex: false,
		});
		const cachedWithoutIndex = elapsed(since);
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

		/** Whether message `i` of the session is at index `i`, loaded or not. */
		const inPlace = () =>
			index.every(
				(entry, at) =>
					chat.messages()[at]?.id === entry.id &&
					chat.messages()[at]?.role === entry.role,
			);
		/** The first and last index of each run of loaded messages before `end`. */
		const loadedRuns = (end = index.length) => {
			const runs: [number, number][] = [];
			for (const [at, message] of chat.messages().slice(0, end).entries()) {
				if (message.historyPlaceholder) continue;
				const last = runs.at(-1);
				if (last && last[1] === at - 1) last[1] = at;
				else runs.push([at, at]);
			}
			return JSON.stringify(runs);
		};
		const until = async (done: () => boolean, what: string) => {
			const deadline = Date.now() + 10_000;
			while (!done()) {
				if (Date.now() > deadline) {
					throw new Error(
						`${what} never happened: ${describe()}, loaded ${loadedRuns()}, ${JSON.stringify(reads.slice(-8))}`,
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		};

		// The range a list shows in the middle of the session is loaded in
		// two pages, each message in its place, and nothing else is read.
		since = performance.now();
		chat.loadRange(5_000, 5_020);
		await until(
			() =>
				loadedRuns() ===
				JSON.stringify([
					[4_944, 5_039],
					[start, 9_999],
				]),
			"the middle of the session loading",
		);
		const rangeMs = elapsed(since);
		const middle = chat.messages()[5_000];
		assert(
			inPlace() &&
				chat.messages().length === index.length &&
				middle?.text === "question 2500" &&
				chat.messages()[5_001]?.text.includes("reply 2500 word") === true &&
				count("page") === 2 &&
				count("page", true) === 0 &&
				reads
					.filter(({ read }) => read === "page")
					.every((page) => page.messages === 48),
			`unexpected messages after loading a range: ${JSON.stringify(reads.slice(-4))}`,
		);

		// With Pi running and no turn, the snapshot has the same window and
		// index, and older messages load from the session file as before.
		await client.startChat({ projectId, sessionKey, sessionPath });
		await until(
			() =>
				chat.state().source === "snapshot" && chat.state().status === "ready",
			"the running chat showing a snapshot",
		);
		assert(
			chat.state().historyPrefix.length === start && inPlace(),
			`unexpected window of the running chat: ${describe()}`,
		);
		chat.loadRange(2_000, 2_020);
		await until(
			() => chat.messages()[2_000]?.historyPlaceholder === undefined,
			"older messages of the running chat loading",
		);
		assert(
			inPlace() && chat.messages()[2_000]?.text === "question 1000",
			`unexpected messages of the running chat: ${describe()}`,
		);

		// The session file grows twice, as it does with each turn. The runtime
		// still answers pages from the file as the chat read it, so no page
		// is of a changed file and the chat is not read again.
		let grown = turns;
		const grow = () => {
			grown += 1;
			fixture.seedTranscript(longSession(grown));
		};
		const pagesBefore = count("page");
		const snapshotsBefore = count("snapshot");
		for (const range of [1_000, 3_000]) {
			grow();
			chat.loadRange(range, range + 20);
			await until(
				() => chat.messages()[range]?.historyPlaceholder === undefined,
				`messages from ${range} loading from the grown file`,
			);
		}
		const whileTheFileGrew = {
			pages: count("page") - pagesBefore,
			pagesOfAChangedFile: count("page", true),
			chatReads: count("snapshot") - snapshotsBefore,
		};
		assert(
			inPlace() &&
				whileTheFileGrew.pagesOfAChangedFile === 0 &&
				whileTheFileGrew.chatReads === 0,
			`unexpected reads while the file grew: ${JSON.stringify(whileTheFileGrew)}`,
		);

		// Once another reader has made the runtime read the grown file, a
		// page comes from a changed file: the chat is read again, once, and
		// the range loads from the file as it is now.
		await client.loadHistory(projectId, sessionPath, { messageLimit: 1 });
		chat.loadRange(7_000, 7_020);
		await until(
			() =>
				chat.messages()[7_000]?.historyPlaceholder === undefined &&
				chat.state().status === "ready",
			"messages loading after the runtime read the grown file",
		);
		const afterAnotherReader = {
			pagesOfAChangedFile: count("page", true),
			chatReads: count("snapshot") - snapshotsBefore,
		};
		assert(
			inPlace() &&
				chat.messages()[7_000]?.text === "question 3500" &&
				chat.state().historyPrefix.length === start + 4 &&
				afterAnotherReader.chatReads === 1,
			`unexpected reads after the file changed: ${JSON.stringify(afterAnotherReader)}`,
		);

		// A turn in progress streams on top of the same window.
		await client.sendChatCommand(sessionKey, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
		await until(
			() => Boolean(chat.state().conversation?.active),
			"the turn streaming",
		);
		const prefix = chat.state().historyPrefix;
		const running = chat.state().conversation?.messages ?? [];
		assert(
			running.at(-2)?.text === "new question" &&
				running.at(-1)?.role === "assistant" &&
				count("snapshot") - snapshotsBefore === 1,
			`unexpected window of the streaming chat: ${describe()}`,
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
			chat.messages().length === prefix.length + running.length &&
				chat.messages()[0] === prefix[0] &&
				chat.messages() === chat.messages(),
			`unexpected joined messages: ${chat.messages().length}`,
		);
		// Joining copies the placeholders, about twenty times the cost of
		// the event itself, so it must not happen unless it is read.
		assert(
			perEvent * 2 < perEventJoined,
			`an event costs ${perEvent} ms, and ${perEventJoined} ms with the join`,
		);

		// While that turn runs, a page of a file that has grown since the
		// chat was read is of a changed file: the chat is read again, once.
		// The runtime serves that snapshot from the projection its pages come
		// from, so the range then loads from the file as it is now, during
		// the turn, and so do the ranges a scrolling list asks for after it,
		// without another read of the chat.
		grow();
		await client.loadHistory(projectId, sessionPath, { messageLimit: 1 });
		const changedBefore = count("page", true);
		const readsBefore = count("snapshot");
		chat.loadRange(8_000, 8_020);
		await until(
			() =>
				chat.messages()[8_000]?.historyPlaceholder === undefined &&
				chat.state().status === "ready",
			"the range loading from the grown file during the turn",
		);
		for (let at = 0; at < 30; at += 1) {
			chat.loadRange(6_000 + at * 50, 6_020 + at * 50);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await until(
			() => chat.messages()[7_450]?.historyPlaceholder === undefined,
			"the range scrolled to last loading during the turn",
		);
		chat.loadRange(8_000, 8_020);
		await until(
			() => chat.messages()[8_000]?.historyPlaceholder === undefined,
			"the first range loading again during the turn",
		);
		const duringATurn = {
			rangesAsked: 32,
			pagesOfAChangedFile: count("page", true) - changedBefore,
			chatReads: count("snapshot") - readsBefore,
		};
		assert(
			inPlace() &&
				chat.state().status === "ready" &&
				chat.messages()[8_000]?.text === "question 4000" &&
				duringATurn.pagesOfAChangedFile > 0 &&
				duringATurn.chatReads === 1,
			`unexpected reads during a turn: ${JSON.stringify(duringATurn)}, ${describe()}`,
		);

		// With the turn over, here by stopping Pi, the chat is read from its
		// settled history again and the range last asked for loads by itself.
		await client.stopChat(sessionKey);
		await until(
			() =>
				chat.state().source === "history" &&
				chat.messages()[8_000]?.historyPlaceholder === undefined,
			"the range loading once the turn is over",
		);
		assert(
			inPlace() &&
				!chat.state().conversation?.active &&
				chat.messages()[8_000]?.text === "question 4000",
			`unexpected messages once the turn is over: ${describe()}`,
		);

		// No read of the store returned more than its window to replay: the
		// rest of the session is never replayed, only shown from the index.
		assert(
			reads.every(
				({ read, messages }) =>
					read === "state" || messages === (read === "page" ? 48 : 80),
			),
			`unexpected reads of a long session: ${JSON.stringify(reads)}`,
		);
		console.log(
			`[transcript-window] ${JSON.stringify({
				sessionBytes: jsonl.length,
				messages: index.length,
				openColdMs: cold,
				openColdCallsMs: coldCalls,
				openColdJsMs: coldJs,
				cachedReadWithIndexMs: cachedWithIndex,
				cachedReadWithoutIndexMs: cachedWithoutIndex,
				openWarmMs: warm,
				loadRangeMs: rangeMs,
				snapshotMs: reads
					.filter(({ read }) => read === "snapshot")
					.map(({ ms }) => ms),
				streamedEventMs: perEvent,
				streamedEventWithJoinMs: perEventJoined,
				whileTheFileGrew,
				afterAnotherReader,
				duringATurn,
			})}`,
		);
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
