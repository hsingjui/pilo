import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, ChatFixture, Pilo } from "app/native";

import { NshPiloClient } from "../client/nsh-pilo-client";

const status = signal("loading models through the client");

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

/** The connection catalog comes from the fixture's stand-in for Pi. */
async function connectionModels() {
	const fixture = new ChatFixture(false);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	try {
		const models = await client.loadConnectionModels("local");
		const [model] = models;
		assert(
			models.length === 1 &&
				model?.provider === "fixture" &&
				model.id === "naming" &&
				model.name === "Naming Model" &&
				!model.reasoning,
			`unexpected connection catalog: ${JSON.stringify(models)}`,
		);
		await expectError(client.loadConnectionModels("missing"), "was not found");
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.loadConnectionModels("local"),
		"Pilo runtime has been shut down",
	);
}

async function projectCatalogAndScope() {
	const fixture = new BootstrapFixture();
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	try {
		const project = (await client.listProjects()).find(
			({ connection }) => connection.id === "local",
		);
		if (!project) throw new Error("missing local fixture project");
		const projectId = project.id;

		assert(
			(await client.loadModels(projectId)) === null,
			"an uncached project had a catalog",
		);
		fixture.seedModelCache(projectId);
		const catalog = await client.loadModels(projectId);
		assert(
			catalog?.projectId === projectId &&
				catalog.models.length === 1 &&
				catalog.models[0]?.id === "workspace-model" &&
				catalog.commands?.[0]?.name === "fixture-command" &&
				catalog.defaultModel?.id === "workspace-model" &&
				catalog.defaultThinkingLevel === "medium" &&
				catalog.refreshedAtMs === 123,
			`unexpected project catalog: ${JSON.stringify(catalog)}`,
		);
		assert(
			(await client.loadModels("missing")) === null,
			"an unknown project had a catalog",
		);

		const inherited = await client.loadModelScope(projectId);
		assert(
			inherited.projectId === projectId &&
				inherited.models === null &&
				inherited.updatedAtMs === 0,
			`unexpected inherited scope: ${JSON.stringify(inherited)}`,
		);
		fixture.seedLegacyModelScope(projectId);
		const stored = await client.loadModelScope(projectId);
		const model = stored.models?.[0];
		assert(
			stored.updatedAtMs === 123 &&
				stored.models?.length === 1 &&
				model?.provider === "fixture" &&
				model.modelId === "saved-model" &&
				model.thinkingLevel === "high" &&
				!model.isDefault,
			`unexpected stored scope: ${JSON.stringify(stored)}`,
		);
		await expectError(
			client.loadModelScope("missing"),
			"Project 'missing' was not found",
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

void connectionModels()
	.then(projectCatalogAndScope)
	.then(() => status.set("client model catalogs and scope verified"))
	.catch((error: unknown) => status.set(String(error)));
