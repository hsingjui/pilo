import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

import { NshPiloClient } from "../client/nsh-pilo-client";

const fixture = new BootstrapFixture();
const status = signal("calling the native module through the client");

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
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	try {
		const initial = await client.bootstrap();
		const local = initial.projects.find(
			(project) => project.connection.id === "local",
		);
		assert(
			local !== undefined &&
				initial.chatSessions.length === 0 &&
				initial.latestSequence === 0 &&
				initial.preferences.revision === 0,
			`unexpected first bootstrap: ${JSON.stringify(initial)}`,
		);
		if (!local) return;
		assert(
			JSON.stringify(await client.listProjects()) ===
				JSON.stringify(initial.projects),
			"project list did not match the bootstrap snapshot",
		);

		const saved = await client.savePreferences({ locale: "zh-CN" });
		const next = await client.bootstrap();
		assert(
			saved.revision === 1 &&
				saved.values.locale === "zh-CN" &&
				JSON.stringify(await client.loadPreferences()) ===
					JSON.stringify(saved) &&
				JSON.stringify(next.preferences) === JSON.stringify(saved) &&
				next.latestSequence > initial.latestSequence,
			"saved preferences did not reach the next load and bootstrap",
		);

		const theme = await client.loadThemeSettings();
		const dark = await client.saveThemeSettings({ theme: "dark" });
		assert(
			dark.theme === "dark" &&
				dark.revision === theme.revision + 1 &&
				JSON.stringify(await client.loadThemeSettings()) ===
					JSON.stringify(dark),
			"saved theme settings did not reach the next load",
		);

		assert(
			(await client.listSessions(local.id)).length === 0,
			"expected a fresh workspace with no indexed sessions",
		);
		fixture.seedIndexedSession(local.id, local.path);
		const [session, ...others] = await client.listSessions(local.id);
		assert(
			others.length === 0 &&
				session?.projectId === local.id &&
				session.piSessionId === "saved-session" &&
				session.name === "Saved session",
			"indexed session did not reach the client",
		);
		await expectError(
			client.listSessions("missing"),
			"Project 'missing' was not found",
		);

		assert(
			(await client.loadSessionReadStates()).length === 0,
			"expected no saved read states",
		);
		const sessionPath = fixture.seedSessionReadState(local.id);
		const [unread] = await client.loadSessionReadStates();
		const read = await client.markSessionRead(local.id, sessionPath, 1);
		assert(
			unread?.sessionPath === sessionPath &&
				unread.readRevision === 0 &&
				read.projectId === local.id &&
				read.sessionPath === sessionPath &&
				read.readRevision === 1,
			"session read state did not round-trip",
		);
		await expectError(
			client.markSessionRead(local.id, sessionPath, 0),
			"session read revision must be a positive safe integer",
		);
	} finally {
		await client.shutdown();
	}
	await expectError(client.bootstrap(), "Pilo runtime has been shut down");
	status.set("client data calls verified against the native module");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
