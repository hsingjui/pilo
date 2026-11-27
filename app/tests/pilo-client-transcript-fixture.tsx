import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { ChatTranscriptSnapshot } from "../client/host-api";
import { createNativeHostClient } from "../client/native-transport";

const projectId = "chat-fixture";
const sessionKey = "nsh-client-transcript-fixture";
const unsavedKey = `${sessionKey}-unsaved`;
const status = signal("taking transcript snapshots through the client");

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

const said = (snapshot: ChatTranscriptSnapshot, text: string) =>
	snapshot.history.history.events.some(
		(event) => event.type === "user_message_start" && event.text === text,
	);

async function run() {
	const fixture = new ChatFixture(false);
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
	const received: PiloClientEvent[] = [];
	let wake = () => {};
	/** The session's first streamed reply text, once the listener has it. */
	const replyDelta = async (key: string) => {
		for (;;) {
			const event = received.find(
				(event) =>
					event.type === "assistant_text_delta" && event.sessionKey === key,
			);
			if (event) return event;
			await new Promise<void>((resolve) => (wake = resolve));
		}
	};
	const prompt = (key: string) =>
		// The fixture's stand-in for Pi leaves a turn open on this command id.
		client.sendChatCommand(key, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
	try {
		// Subscribed before any snapshot, as the cut requires.
		await client.connectEvents({
			onMessage: (message) => {
				if (message.type === "events") received.push(...message.events);
				wake();
			},
			onStatus: () => wake(),
		});
		await expectError(
			client.chatTranscriptSnapshot(sessionKey),
			"chat session is not running",
		);

		const sessionPath = fixture.seedTranscript(
			`${JSON.stringify({
				type: "message",
				id: "prior-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "saved question" },
			})}\n`,
		);
		const { generation } = await client.startChat({
			projectId,
			sessionKey,
			sessionPath,
		});
		const idle = await client.chatTranscriptSnapshot(sessionKey, {
			messageLimit: 1,
			includeMessageIndex: true,
		});
		assert(
			idle.sessionKey === sessionKey &&
				idle.generation === generation &&
				idle.live.type === "idle" &&
				idle.history.fingerprint !== null &&
				idle.history.history.messageIndex?.length === 1 &&
				said(idle, "saved question"),
			`unexpected idle snapshot: ${JSON.stringify(idle)}`,
		);

		await prompt(sessionKey);
		const delta = await replyDelta(sessionKey);
		const active = await client.chatTranscriptSnapshot(sessionKey);
		assert(
			active.generation === generation &&
				active.live.type === "active" &&
				// The cut covers the reply text the listener already has.
				active.eventSequence >= delta.sequence &&
				active.live.events.some(
					(event) =>
						event.type === "user_message_start" &&
						event.text === "new question",
				) &&
				active.live.events.some(
					(event) =>
						event.type === "assistant_text_delta" &&
						event.delta === "partial reply",
				) &&
				// The saved history stops where the running turn began.
				said(active, "saved question") &&
				!said(active, "new question"),
			`unexpected active snapshot: ${JSON.stringify(active)}`,
		);
		await client.stopChat(sessionKey);

		// A turn of a chat with no saved session cannot be rebuilt from a cut.
		const unsaved = await client.startChat({
			projectId,
			sessionKey: unsavedKey,
			noSession: true,
		});
		await prompt(unsavedKey);
		const unsavedDelta = await replyDelta(unsavedKey);
		const truncated = await client.chatTranscriptSnapshot(unsavedKey);
		assert(
			truncated.sessionKey === unsavedKey &&
				truncated.generation === unsaved.generation &&
				truncated.live.type === "truncated" &&
				truncated.eventSequence >= unsavedDelta.sequence &&
				truncated.history.fingerprint === null &&
				truncated.history.history.events.length === 0,
			`unexpected truncated snapshot: ${JSON.stringify(truncated)}`,
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.chatTranscriptSnapshot(sessionKey),
		"Pilo runtime has been shut down",
	);
	status.set("client transcript snapshots verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
