import { mount, signal, Text } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";
import type { PromptEnhancementSettings } from "@shared/prompt-enhancement-types";

const status = signal("loading prompt enhancement settings");

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
		await hostClient.listProjects();
		const initial = (await hostClient.loadPromptEnhancementSettings(
			"local",
		)) as PromptEnhancementSettings;
		if (
			initial.connectionId !== "local" ||
			initial.enabled !== false ||
			initial.model !== null ||
			initial.updatedAtMs !== 0
		) {
			throw new Error(`unexpected defaults: ${JSON.stringify(initial)}`);
		}
		fixture.seedPromptEnhancementSettings();
		const stored = (await hostClient.loadPromptEnhancementSettings(
			"local",
		)) as PromptEnhancementSettings;
		if (
			stored.connectionId !== "local" ||
			stored.enabled !== true ||
			stored.model?.provider !== "fixture" ||
			stored.model.id !== "rewrite" ||
			stored.updatedAtMs !== 123
		) {
			throw new Error(`unexpected saved settings: ${JSON.stringify(stored)}`);
		}
		await expectError(
			hostClient.loadPromptEnhancementSettings("missing"),
			"Connection 'missing' was not found",
		);
		await pilo.shutdown();
		await expectError(
			hostClient.loadPromptEnhancementSettings("local"),
			"Pilo runtime has been shut down",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("prompt enhancement settings loaded");
}

mount(() => <Text>{status()}</Text>);
void run().catch((error: unknown) => status.set(String(error)));
