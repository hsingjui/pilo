import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import type { NativeSessionReadState } from "app/native";

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
	const projectId = "default-workspace:local";
	let sessionPath: string;
	try {
		if ((await pilo.loadSessionReadStates()).length !== 0) {
			throw new Error("expected no saved read states");
		}
		await pilo.listProjects();
		sessionPath = fixture.seedSessionReadState(projectId);
		const states = await pilo.loadSessionReadStates();
		if (states.length !== 1) throw new Error("expected one saved read state");
		expectReadState(states[0], projectId, sessionPath, 0);
		for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			await expectError(
				pilo.markSessionRead(projectId, sessionPath, revision),
				"session read revision must be a positive safe integer",
			);
		}
		await expectError(
			pilo.markSessionRead("other-project", sessionPath, 1),
			"failed to mark session read",
		);
		expectReadState(
			await pilo.markSessionRead(projectId, sessionPath, 1),
			projectId,
			sessionPath,
			1,
		);
		expectReadState(
			await pilo.markSessionRead(
				projectId,
				sessionPath,
				Number.MAX_SAFE_INTEGER,
			),
			projectId,
			sessionPath,
			2,
		);
		expectReadState(
			await pilo.markSessionRead(projectId, sessionPath, 1),
			projectId,
			sessionPath,
			2,
		);
	} finally {
		await pilo.shutdown();
	}
	const closed = "Pilo runtime has been shut down";
	await expectError(pilo.loadSessionReadStates(), closed);
	await expectError(pilo.markSessionRead(projectId, sessionPath, 2), closed);

	const reopened = new Pilo(fixture.dataDir());
	try {
		const states = await reopened.loadSessionReadStates();
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
