import { mount, signal, Text, View } from "nsh";
import { Pilo, SessionFilesFixture } from "app/native";

import type { SessionHistoryResult } from "@shared/api/sessions-types";
import { NshPiloClient } from "../client/nsh-pilo-client";

const projectId = "session-files";
const status = signal("reading settled history through the client");

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

const asks = (result: SessionHistoryResult, text: string) =>
	result.history.events.some(
		(event) => event.type === "user_message_start" && event.text === text,
	);
const replies = (result: SessionHistoryResult, text: string) =>
	result.history.events.some(
		(event) => event.type === "assistant_text_delta" && event.delta === text,
	);

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
	const sessionPath = fixture.sessionPath();
	try {
		// Without options: the whole short session, with its message index.
		const full = await client.loadHistory(projectId, sessionPath);
		assert(
			full.history.totalMessages === 3 &&
				full.history.windowStartMessage === 0 &&
				full.history.windowMessageCount === 3 &&
				full.history.messageIndex?.length === 3 &&
				asks(full, "saved question") &&
				replies(full, "saved reply") &&
				asks(full, "second question") &&
				full.fingerprint !== null &&
				full.fingerprint.fileSize > 0,
			`unexpected settled history: ${JSON.stringify(full)}`,
		);

		// A window of one message, checked against the first read's file.
		const window = await client.loadHistory(projectId, sessionPath, {
			startMessage: 1,
			messageLimit: 1,
			includeMessageIndex: false,
			fingerprint: full.fingerprint ?? undefined,
		});
		assert(
			window.history.totalMessages === 3 &&
				window.history.windowStartMessage === 1 &&
				window.history.windowMessageCount === 1 &&
				window.history.messageIndex === undefined &&
				replies(window, "saved reply") &&
				!asks(window, "saved question") &&
				!asks(window, "second question") &&
				window.fingerprint?.fileSize === full.fingerprint?.fileSize &&
				window.fingerprint?.fileMtimeNs === full.fingerprint?.fileMtimeNs,
			`unexpected history window: ${JSON.stringify(window)}`,
		);

		// With only a limit, the window is the end of the session.
		const tail = await client.loadHistory(projectId, sessionPath, {
			messageLimit: 1,
		});
		assert(
			tail.history.windowStartMessage === 2 &&
				tail.history.windowMessageCount === 1 &&
				asks(tail, "second question") &&
				!replies(tail, "saved reply"),
			`unexpected history tail: ${JSON.stringify(tail)}`,
		);

		await expectError(
			client.loadHistory(
				projectId,
				sessionPath.replace(/fixture\.jsonl$/, "missing.jsonl"),
			),
			"No such file or directory",
		);
		await expectError(
			client.loadHistory("missing", sessionPath),
			"Project 'missing' was not found",
		);
		// Reading history starts no chat.
		assert(
			(await client.bootstrap()).chatSessions.length === 0,
			"reading history started a chat",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.loadHistory(projectId, sessionPath),
		"Pilo runtime has been shut down",
	);
	status.set("client settled history verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
