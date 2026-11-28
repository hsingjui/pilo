import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const fixture = new BootstrapFixture();
const status = signal("loading projects and sessions");

type CatalogProject = {
	id: string;
	path: string;
	connection: { id: string };
};

type IndexedSession = {
	projectId: string;
	piSessionId: string;
	name: string;
	fileMtimeNs: string;
};

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
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const projects = (await hostClient.listProjects()) as CatalogProject[];
		const local = projects.find((project) => project.connection.id === "local");
		if (
			!local ||
			JSON.stringify(projects) !==
				JSON.stringify((await hostClient.bootstrap()).projects)
		) {
			throw new Error("standalone project catalog did not match bootstrap");
		}
		if ((await hostClient.listSessions(local.id)).length !== 0) {
			throw new Error("expected a fresh workspace with no indexed sessions");
		}
		fixture.seedIndexedSession(local.id, local.path);
		const sessions = (await hostClient.listSessions(
			local.id,
		)) as IndexedSession[];
		const [session] = sessions;
		if (
			sessions.length !== 1 ||
			session?.projectId !== local.id ||
			session.piSessionId !== "saved-session" ||
			session.name !== "Saved session" ||
			session.fileMtimeNs !== "1767225601000000001"
		) {
			throw new Error("saved session did not preserve the indexed values");
		}
		await expectError(
			hostClient.listSessions("missing"),
			"Project 'missing' was not found",
		);
	} finally {
		await pilo.shutdown();
	}
	await expectError(
		hostClient.listProjects(),
		"Pilo runtime has been shut down",
	);
	await expectError(
		hostClient.listSessions("missing"),
		"Pilo runtime has been shut down",
	);
	status.set("project catalog and saved sessions loaded");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
