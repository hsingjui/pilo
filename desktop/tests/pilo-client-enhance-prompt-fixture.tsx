import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import { NshPiloClient } from "../client/nsh-pilo-client";

const projectId = "chat-fixture";
const status = signal("rewriting a draft through the client");
const model = (id: string) => ({ provider: "fixture", id });

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
	try {
		await expectError(
			client.enhancePrompt(projectId, "rewrite this", null),
			"Prompt enhancement is disabled",
		);

		// The model saved for the connection is used before the chat's.
		await client.savePromptEnhancementSettings("local", true, model("rewrite"));
		const configured = await client.enhancePrompt(
			projectId,
			"  rewrite this  ",
			model("chat"),
		);
		assert(
			configured === "rewrite: rewrite this",
			`unexpected rewrite with the saved model: ${configured}`,
		);
		await client.savePromptEnhancementSettings("local", true, null);
		const fallback = await client.enhancePrompt(
			projectId,
			"rewrite this",
			model("chat"),
		);
		assert(
			fallback === "chat: rewrite this",
			`unexpected rewrite with the chat's model: ${fallback}`,
		);

		await expectError(
			client.enhancePrompt(projectId, "  ", model("chat")),
			"Draft is empty",
		);
		await expectError(
			client.enhancePrompt(projectId, "rewrite this", model("unavailable")),
			"Model fixture/unavailable is unavailable",
		);
		await expectError(
			client.enhancePrompt(projectId, "fail generation", model("chat")),
			"fixture generation failed",
		);
		await expectError(
			client.enhancePrompt("missing", "rewrite this", model("chat")),
			"Project 'missing' was not found",
		);
		// A rewrite starts no chat.
		assert(
			(await client.bootstrap()).chatSessions.length === 0,
			"rewriting a draft left a chat running",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.enhancePrompt(projectId, "rewrite this", null),
		"Pilo runtime has been shut down",
	);
	status.set("client prompt enhancement verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
