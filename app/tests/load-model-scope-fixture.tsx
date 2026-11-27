import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("loading project model scope");

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
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const projects = (await hostClient.listProjects()) as {
			id: string;
			connection: { id: string };
		}[];
		const project = projects.find(
			({ connection }) => connection.id === "local",
		);
		if (!project) throw new Error("missing local fixture project");
		const projectId = project.id;

		const initial = (await hostClient.loadModelScope(projectId)) as {
			projectId: string;
			models: unknown;
			updatedAtMs: number;
		};
		if (
			initial.projectId !== projectId ||
			initial.models !== null ||
			initial.updatedAtMs !== 0
		) {
			throw new Error(`unexpected inherited scope: ${JSON.stringify(initial)}`);
		}

		fixture.seedLegacyModelScope(projectId);
		const stored = (await hostClient.loadModelScope(projectId)) as {
			projectId: string;
			models: {
				provider: string;
				modelId: string;
				thinkingLevel: string;
				isDefault: boolean;
			}[];
			updatedAtMs: number;
		};
		const [model] = stored.models;
		if (
			stored.projectId !== projectId ||
			stored.updatedAtMs !== 123 ||
			stored.models.length !== 1 ||
			model?.provider !== "fixture" ||
			model.modelId !== "saved-model" ||
			model.thinkingLevel !== "high" ||
			model.isDefault !== false
		) {
			throw new Error(`unexpected stored scope: ${JSON.stringify(stored)}`);
		}

		await expectError(
			hostClient.loadModelScope("missing"),
			"Project 'missing' was not found",
		);
		await pilo.shutdown();
		await expectError(
			hostClient.loadModelScope(projectId),
			"Pilo runtime has been shut down",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("inherited and stored model scopes verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
