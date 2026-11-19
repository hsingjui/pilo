import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@/lib/api/pilo-client";
import { decodeNextPromptResult } from "@/lib/next-prompt";
import type { NextPromptRequest } from "@/lib/next-prompt-types";
import { NshPiloClient } from "../client/nsh-pilo-client";

const sessionKey = "nsh-client-next-prompt-fixture";
const status = signal("requesting a next prompt through the client");

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
	/** The first event of this chat, in arrival order, that matches. */
	const eventually = async (matches: (event: PiloClientEvent) => boolean) => {
		for (;;) {
			const event = received.find(matches);
			if (event) return event;
			await new Promise<void>((resolve) => (wake = resolve));
		}
	};
	try {
		await client.connectEvents({
			onMessage: (message) => {
				if (message.type === "events") received.push(...message.events);
				wake();
			},
			onStatus: () => wake(),
		});
		const model = { provider: "fixture", id: "naming" };
		const settings = await client.saveNextPromptSettings("local", true, model);
		const request: NextPromptRequest = {
			sessionKey,
			sessionId: "fixture-session",
			requestId: "client-fixture-predict",
			generation: 0,
			revision: settings.updatedAtMs,
		};
		await expectError(
			client.requestNextPrompt(request),
			"prediction session is not running",
		);

		const started = await client.startChat({
			projectId: "chat-fixture",
			sessionKey,
			noSession: true,
		});
		request.generation = started.generation;
		await expectError(
			client.requestNextPrompt({ ...request, requestId: "bad id" }),
			"invalid next prompt request identity",
		);
		// The chat takes requests once its next-prompt extension reports ready,
		// which the fixture's stand-in for Pi does on this command id.
		await client.sendChatCommand(sessionKey, {
			id: "fixture-next-prompt-ready",
			type: "get_state",
		});
		await eventually(
			(event) =>
				event.type === "extension_ui_request" &&
				event.widgetKey === "pilo.next-prompt.ready.v1" &&
				event.widgetLines?.[0] === "ready",
		);

		// The call resolves when sent; the suggestion arrives as an event.
		await client.requestNextPrompt(request);
		const event = await eventually(
			(candidate) => decodeNextPromptResult(candidate) !== null,
		);
		const result = decodeNextPromptResult(event);
		assert(
			event.type === "extension_ui_request" &&
				event.generation === request.generation &&
				result?.requestId === request.requestId &&
				result.sessionId === request.sessionId &&
				result.revision === request.revision &&
				result.status === "ready" &&
				result.text === "What comes next?",
			`unexpected next-prompt result: ${JSON.stringify(result)}`,
		);

		await expectError(
			client.requestNextPrompt({ ...request, revision: request.revision - 1 }),
			"prediction settings changed",
		);
		// A cancel is sent even after prediction was turned off.
		await client.saveNextPromptSettings("local", false, model);
		await client.requestNextPrompt({ ...request, cancel: true });
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.requestNextPrompt({
			sessionKey,
			sessionId: "fixture-session",
			requestId: "client-fixture-predict",
			generation: 1,
			revision: 1,
		}),
		"Pilo runtime has been shut down",
	);
	status.set("client next-prompt suggestion and cancel verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
