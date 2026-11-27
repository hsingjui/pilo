import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("loading project models");

async function run() {
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	let projectId = "";
	try {
		const projects = (await hostClient.listProjects()) as {
			id: string;
			connection: { id: string };
		}[];
		const project = projects.find((entry) => entry.connection.id === "local");
		if (!project) throw new Error("missing local fixture project");
		projectId = project.id;
		if ((await hostClient.loadModels(projectId)) !== null) {
			throw new Error("unexpected catalog for an uncached project");
		}
		fixture.seedModelCache(projectId);
		const catalog = (await hostClient.loadModels(projectId)) as {
			projectId: string;
			models: { id: string; scopeOrder: number; scopeThinkingLevel: string }[];
			commands: { name: string; sourceInfo: { scope: string } }[];
			defaultModel: { id: string };
			defaultThinkingLevel: string;
			refreshedAtMs: number;
		} | null;
		if (
			catalog?.projectId !== projectId ||
			catalog.models.length !== 1 ||
			catalog.models[0]?.id !== "workspace-model" ||
			catalog.models[0]?.scopeOrder !== 0 ||
			catalog.models[0]?.scopeThinkingLevel !== "low" ||
			catalog.commands[0]?.name !== "fixture-command" ||
			catalog.commands[0]?.sourceInfo.scope !== "project" ||
			catalog.defaultModel.id !== "workspace-model" ||
			catalog.defaultThinkingLevel !== "medium" ||
			catalog.refreshedAtMs !== 123 ||
			(await hostClient.loadModels("missing")) !== null
		) {
			throw new Error(`unexpected project catalog: ${JSON.stringify(catalog)}`);
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	try {
		await hostClient.loadModels(projectId);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("Pilo runtime has been shut down")
		) {
			status.set("saved project models verified");
			return;
		}
		throw error;
	}
	throw new Error("project model load succeeded after shutdown");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
