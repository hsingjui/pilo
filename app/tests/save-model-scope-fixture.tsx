import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("saving project model scope");

type Model = {
	provider: string;
	modelId: string;
	thinkingLevel: string | null;
	isDefault?: boolean;
};
type Scope = {
	projectId: string;
	models: Model[] | null;
	updatedAtMs: number;
};

const models: Model[] = [
	{ provider: "fixture", modelId: "unavailable", thinkingLevel: "high" },
	{
		provider: "fixture",
		modelId: "default",
		thinkingLevel: null,
		isDefault: true,
	},
];

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

function expectScope(actual: unknown, expected: Scope) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`unexpected stored scope: ${JSON.stringify(actual)}`);
	}
}

async function expectScopeEvent(pilo: Pilo, sequence: number, scope: Scope) {
	const batch = (await pilo.nextEvents(1)) as {
		type: string;
		events?: {
			type: string;
			sequence: number;
			projectId: string;
			scope: Scope;
		}[];
	};
	const event = batch.events?.[0];
	if (
		batch.type !== "events" ||
		event?.type !== "project_model_scope_changed" ||
		event.sequence !== sequence ||
		event.projectId !== scope.projectId
	) {
		throw new Error(`unexpected model scope event: ${JSON.stringify(batch)}`);
	}
	expectScope(event.scope, scope);
}

async function run() {
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const initial = await hostClient.bootstrap();
		const projects = initial.projects as {
			id: string;
			connection: { id: string };
		}[];
		const project = projects.find(
			({ connection }) => connection.id === "local",
		);
		if (!project) throw new Error("missing local fixture project");
		const projectId = project.id;
		const saved = (await hostClient.saveModelScope(
			projectId,
			models as never,
		)) as Scope;
		const [first, second] = saved.models ?? [];
		if (
			saved.projectId !== projectId ||
			!(saved.updatedAtMs > 0) ||
			saved.models?.length !== 2 ||
			first?.provider !== "fixture" ||
			first.modelId !== "unavailable" ||
			first.thinkingLevel !== "high" ||
			first.isDefault !== false ||
			second?.provider !== "fixture" ||
			second.modelId !== "default" ||
			second.thinkingLevel !== null ||
			second.isDefault !== true
		) {
			throw new Error(`unexpected saved scope: ${JSON.stringify(saved)}`);
		}
		await expectScopeEvent(pilo, initial.latestSequence + 1, saved);

		await expectError(
			hostClient.saveModelScope(projectId, [models[0], models[0]] as never),
			"model scope contains duplicate model identities",
		);
		await expectError(
			hostClient.saveModelScope(projectId, [
				{ ...models[0], isDefault: true },
				models[1],
			] as never),
			"model scope can contain only one default model",
		);
		await expectError(
			hostClient.saveModelScope(projectId, [
				{ ...models[0], modelId: " " },
			] as never),
			"model scope provider and model id cannot be empty",
		);
		await expectError(
			hostClient.saveModelScope(projectId, [
				{ ...models[0], thinkingLevel: "bogus" },
			] as never),
			"unknown variant",
		);
		await expectError(
			hostClient.saveModelScope("missing", []),
			"Project 'missing' was not found",
		);
		expectScope(await hostClient.loadModelScope(projectId), saved);

		const empty = (await hostClient.saveModelScope(projectId, [])) as Scope;
		if (
			empty.models?.length !== 0 ||
			!(empty.updatedAtMs > saved.updatedAtMs)
		) {
			throw new Error(`unexpected empty scope: ${JSON.stringify(empty)}`);
		}
		expectScope(await hostClient.loadModelScope(projectId), empty);
		await expectScopeEvent(pilo, initial.latestSequence + 2, empty);

		const inherited = (await hostClient.saveModelScope(
			projectId,
			null,
		)) as Scope;
		if (
			inherited.models !== null ||
			!(inherited.updatedAtMs > empty.updatedAtMs)
		) {
			throw new Error(
				`unexpected inherited scope: ${JSON.stringify(inherited)}`,
			);
		}
		await expectScopeEvent(pilo, initial.latestSequence + 3, inherited);
		await pilo.shutdown();
		await expectError(
			hostClient.saveModelScope(projectId, [] as never),
			"Pilo runtime has been shut down",
		);
		const reopened = new Pilo(fixture.dataDir());
		const reopenedClient = createNativeHostClient(reopened);
		try {
			expectScope(await reopenedClient.loadModelScope(projectId), inherited);
		} finally {
			await reopened.shutdown();
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("model scope updates verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
