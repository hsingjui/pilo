import { mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo, SessionFilesFixture } from "app/native";

import { createNativeHostClient } from "../client/native-transport";

const status = signal("checking session actions through the client");
const timestamp = "2025-01-02T03:04:05.000Z";

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

async function searchAndDelete() {
	const projectId = "session-files";
	const jsonl = [
		{
			type: "message",
			id: "user-message",
			parentId: null,
			timestamp,
			message: { role: "user", content: "Find the needle" },
		},
		{
			type: "message",
			id: "assistant-message",
			parentId: "user-message",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Found the needle" }],
			},
		},
	]
		.map((line) => JSON.stringify(line))
		.join("\n");
	const fixture = new SessionFilesFixture(`${jsonl}\n`);
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
	const sessionPath = fixture.sessionPath();
	try {
		const matches = await client.searchSessions(projectId, "needle");
		assert(
			matches.length === 2 &&
				matches.every(
					(match) =>
						match.sessionPath === sessionPath && match.timestamp === timestamp,
				) &&
				matches[0]?.role === "user" &&
				matches[0].snippet === "Find the needle" &&
				matches[1]?.role === "assistant",
			`unexpected search results: ${JSON.stringify(matches)}`,
		);
		assert(
			(await client.searchSessions(projectId, "needle", 1)).length === 1 &&
				(await client.searchSessions(projectId, "no match")).length === 0,
			"a limited or unmatched search returned the wrong count",
		);
		await expectError(
			client.searchSessions("missing", "needle"),
			"was not found",
		);

		// Deletion needs the session index, which listing the sessions builds.
		await expectError(
			client.deleteSession(projectId, sessionPath),
			"not indexed",
		);
		const sessions = await client.listSessions(projectId);
		assert(
			sessions.length === 1 && sessions[0]?.sessionPath === sessionPath,
			`unexpected session list: ${JSON.stringify(sessions)}`,
		);
		const { method } = await client.deleteSession(projectId, sessionPath);
		assert(
			method === "trash" || method === "unlink",
			`unexpected delete result: ${method}`,
		);
		assert(
			(await client.listSessions(projectId)).length === 0 &&
				(await client.searchSessions(projectId, "needle")).length === 0,
			"the deleted session is still listed or found",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.searchSessions(projectId, "needle"),
		"Pilo runtime has been shut down",
	);
}

async function generateTitle() {
	const projectId = "chat-fixture";
	const fixture = new ChatFixture(false);
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
	try {
		assert(
			(await client.generateSessionTitle(projectId, "Repair the parser")) ===
				null,
			"a title came back with no naming model configured",
		);
		fixture.configureNamingModel();
		assert(
			(await client.generateSessionTitle(
				projectId,
				"  Repair the parser  ",
			)) === "Repair the parser",
			"the naming model did not return the normalized title",
		);
		await expectError(
			client.generateSessionTitle("missing", "Repair the parser"),
			"was not found",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void searchAndDelete()
	.then(generateTitle)
	.then(() => status.set("client session search, deletion and title verified"))
	.catch((error: unknown) => status.set(String(error)));
