import { host, mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo, SessionFilesFixture } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("checking session actions");
const projectId = "session-files";
const sessionId = "session-files-fixture";
const timestamp = "2025-01-02T03:04:05.000Z";

function check(condition: boolean, message: string) {
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
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	const sessionPath = fixture.sessionPath();
	try {
		const matches = (await hostClient.searchSessions(
			projectId,
			"  NEEDLE  ",
		)) as {
			sessionPath: string;
			sessionId: string;
			role: string;
			snippet: string;
			timestamp: string;
		}[];
		check(
			matches.length === 2 &&
				matches.every(
					(match) =>
						match.sessionPath === sessionPath &&
						match.sessionId === sessionId &&
						match.timestamp === timestamp,
				) &&
				matches[0]?.role === "user" &&
				matches[0]?.snippet === "Find the needle" &&
				matches[1]?.role === "assistant",
			`unexpected search results: ${JSON.stringify(matches)}`,
		);
		check(
			(await hostClient.searchSessions(projectId, "needle", 1)).length === 1 &&
				(await hostClient.searchSessions(projectId, "    ")).length === 0 &&
				(await hostClient.searchSessions(projectId, "no match")).length === 0,
			"unexpected limited or empty search results",
		);
		await expectError(
			hostClient.searchSessions(projectId, "needle", 1.5),
			"invalid type: floating point `1.5`",
		);
		await expectError(
			hostClient.searchSessions("missing", "needle"),
			"was not found",
		);
		await expectError(
			hostClient.deleteSession(projectId, sessionPath),
			"not indexed",
		);
		check(
			(await hostClient.listSessions(projectId)).length === 1,
			"session was not indexed by reconciliation",
		);
		const deletion = (await hostClient.deleteSession(
			projectId,
			sessionPath,
		)) as {
			method: string;
		};
		check(
			deletion.method === "trash" || deletion.method === "unlink",
			`unexpected delete result: ${JSON.stringify(deletion)}`,
		);
		await expectError(
			hostClient.deleteSession(projectId, sessionPath),
			"not indexed",
		);
		check(
			(await hostClient.searchSessions(projectId, "needle")).length === 0 &&
				(await hostClient.listSessions(projectId)).length === 0,
			"deleted session is still discoverable",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	await expectError(
		hostClient.searchSessions(projectId, "needle"),
		"Pilo runtime has been shut down",
	);
	await expectError(
		hostClient.deleteSession(projectId, sessionPath),
		"Pilo runtime has been shut down",
	);
	status.set("session search and deletion verified");
}

async function generateTitle() {
	const projectId = "chat-fixture";
	const message = "Repair the parser";
	const fixture = new ChatFixture(false);
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		check(
			(await hostClient.generateSessionTitle(projectId, message)) === null,
			"an unconfigured naming model returned a title",
		);
		fixture.configureNamingModel();
		check(
			(await hostClient.generateSessionTitle(projectId, "    ")) === null,
			"blank input returned a title",
		);
		await expectError(
			hostClient.generateSessionTitle("missing", message),
			"was not found",
		);
		check(
			(await hostClient.generateSessionTitle(projectId, `  ${message}  `)) ===
				message,
			"the naming prompt did not return a normalized title",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	await expectError(
		hostClient.generateSessionTitle(projectId, message),
		"Pilo runtime has been shut down",
	);
	status.set("session title generation verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

const run = host.params.naming === true ? generateTitle : searchAndDelete;
void run().catch((error: unknown) => status.set(String(error)));
