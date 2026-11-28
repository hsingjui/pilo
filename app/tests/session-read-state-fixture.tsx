import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";
import type { SessionReadState as NativeSessionReadState } from "@shared/session-read-state";

const fixture = new BootstrapFixture();
const status = signal("loading session read states");

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

function expectReadState(
	state: NativeSessionReadState | undefined,
	projectId: string,
	sessionPath: string,
	readRevision: number,
) {
	if (
		state?.projectId !== projectId ||
		state.sessionPath !== sessionPath ||
		state.completedRevision !== 2 ||
		state.readRevision !== readRevision
	) {
		throw new Error(`unexpected session read state: ${JSON.stringify(state)}`);
	}
}

async function run() {
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	const projectId = "default-workspace:local";
	let sessionPath: string;
	try {
		if ((await hostClient.loadSessionReadStates()).length !== 0) {
			throw new Error("expected no saved read states");
		}
		await hostClient.listProjects();
		sessionPath = fixture.seedSessionReadState(projectId);
		const states = await hostClient.loadSessionReadStates();
		if (states.length !== 1) throw new Error("expected one saved read state");
		expectReadState(states[0], projectId, sessionPath, 0);
		for (const [revision, message] of [
			[0, "session read revision must be a positive safe integer"],
			[-1, "session read revision must be a positive safe integer"],
			[1.5, "session read revision must be a positive safe integer"],
		] as const) {
			await expectError(
				hostClient.markSessionRead(projectId, sessionPath, revision),
				message,
			);
		}
		await expectError(
			hostClient.markSessionRead("other-project", sessionPath, 1),
			"failed to mark session read",
		);
		expectReadState(
			await hostClient.markSessionRead(projectId, sessionPath, 1),
			projectId,
			sessionPath,
			1,
		);
		expectReadState(
			await hostClient.markSessionRead(projectId, sessionPath, 2 ** 31 - 1),
			projectId,
			sessionPath,
			2,
		);
		expectReadState(
			await hostClient.markSessionRead(projectId, sessionPath, 1),
			projectId,
			sessionPath,
			2,
		);
	} finally {
		await pilo.shutdown();
	}
	const closed = "Pilo runtime has been shut down";
	await expectError(hostClient.loadSessionReadStates(), closed);
	await expectError(
		hostClient.markSessionRead(projectId, sessionPath, 2),
		closed,
	);

	const reopened = new Pilo(fixture.dataDir());
	const reopenedClient = createNativeHostClient(reopened);
	try {
		const states = await reopenedClient.loadSessionReadStates();
		if (states.length !== 1)
			throw new Error("expected one persisted read state");
		expectReadState(states[0], projectId, sessionPath, 2);
	} finally {
		await reopened.shutdown();
	}
	status.set("session read states loaded, acknowledged, and persisted");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
