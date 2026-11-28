import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, ChatFixture, Pilo } from "app/native";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { ProjectScopedModel } from "@shared/project-model-scope";
import { createNativeHostClient } from "../client/native-transport";

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
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
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
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
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

function sameModels(
	actual: ProjectScopedModel[] | null,
	expected: ProjectScopedModel[] | null,
) {
	return (
		actual?.length === expected?.length &&
		(actual ?? []).every((model, index) => {
			const other = expected?.[index];
			return (
				model.provider === other?.provider &&
				model.modelId === other.modelId &&
				model.thinkingLevel === other.thinkingLevel &&
				model.isDefault === other.isDefault
			);
		})
	);
}

async function saveScope() {
	const fixture = new BootstrapFixture();
	const client = createNativeHostClient(new Pilo(fixture.dataDir()));
	const received: PiloClientEvent[] = [];
	let wake = () => {};
	try {
		await client.connectEvents({
			onMessage: (message) => {
				if (message.type === "events") received.push(...message.events);
				wake();
			},
			onStatus: () => wake(),
		});
		const project = (await client.listProjects()).find(
			({ connection }) => connection.id === "local",
		);
		if (!project) throw new Error("missing local fixture project");
		const projectId = project.id;
		const unavailable: ProjectScopedModel = {
			provider: "fixture",
			modelId: "unavailable",
			thinkingLevel: "high",
		};
		const preferred: ProjectScopedModel = {
			provider: "fixture",
			modelId: "default",
			thinkingLevel: null,
			isDefault: true,
		};
		const models = [unavailable, preferred];

		const saved = await client.saveModelScope(projectId, models);
		assert(
			saved.projectId === projectId &&
				saved.updatedAtMs > 0 &&
				sameModels(saved.models, [
					{ ...unavailable, isDefault: false },
					preferred,
				]),
			`unexpected saved scope: ${JSON.stringify(saved)}`,
		);
		const loaded = await client.loadModelScope(projectId);
		assert(
			loaded.updatedAtMs === saved.updatedAtMs &&
				sameModels(loaded.models, saved.models),
			`the loaded scope differs from the saved one: ${JSON.stringify(loaded)}`,
		);
		// The save also reaches listeners as an event carrying the scope.
		while (received.length === 0) {
			await new Promise<void>((resolve) => (wake = resolve));
		}
		const [event] = received;
		assert(
			event?.type === "project_model_scope_changed" &&
				event.scope.updatedAtMs === saved.updatedAtMs &&
				sameModels(event.scope.models, saved.models),
			`unexpected scope event: ${JSON.stringify(event)}`,
		);

		await expectError(
			client.saveModelScope(projectId, [
				{ ...unavailable, isDefault: true },
				preferred,
			]),
			"model scope can contain only one default model",
		);
		await expectError(
			client.saveModelScope("missing", []),
			"Project 'missing' was not found",
		);

		const empty = await client.saveModelScope(projectId, []);
		assert(
			empty.models?.length === 0 && empty.updatedAtMs > saved.updatedAtMs,
			`unexpected empty scope: ${JSON.stringify(empty)}`,
		);
		const inherited = await client.saveModelScope(projectId, null);
		assert(
			inherited.models === null && inherited.updatedAtMs > empty.updatedAtMs,
			`unexpected inherited scope: ${JSON.stringify(inherited)}`,
		);
		assert(
			(await client.loadModelScope(projectId)).models === null,
			"the scope did not go back to inheriting Pi's",
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
	.then(saveScope)
	.then(() => status.set("client model catalogs and scope saves verified"))
	.catch((error: unknown) => status.set(String(error)));
