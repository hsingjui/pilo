import { mount, signal, Text } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@shared/prompt-enhancement-types";

const status = signal("saving prompt enhancement settings");
const model = { provider: "fixture", id: "rewrite" };

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

function expectSnapshot(actual: unknown, expected: PromptEnhancementSettings) {
	const settings = actual as PromptEnhancementSettings | null;
	if (
		settings?.connectionId !== expected.connectionId ||
		settings.enabled !== expected.enabled ||
		settings.updatedAtMs !== expected.updatedAtMs ||
		(expected.model
			? settings.model?.provider !== expected.model.provider ||
				settings.model.id !== expected.model.id
			: settings.model !== null)
	) {
		throw new Error(
			`unexpected prompt enhancement settings: ${JSON.stringify(actual)}`,
		);
	}
}

async function save(
	pilo: Pilo,
	enabled: boolean,
	selected: PromptEnhancementModel | null,
	previousRevision: number,
	sequence: number,
) {
	const hostClient = createNativeHostClient(pilo);
	const saved = (await hostClient.savePromptEnhancementSettings(
		"local",
		enabled,
		selected,
	)) as PromptEnhancementSettings;
	if (!(saved.updatedAtMs > previousRevision)) {
		throw new Error(`the revision did not advance: ${JSON.stringify(saved)}`);
	}
	expectSnapshot(saved, {
		connectionId: "local",
		enabled,
		model: selected,
		updatedAtMs: saved.updatedAtMs,
	});
	const batch = (await pilo.nextEvents(1)) as {
		type: string;
		events?: {
			type: string;
			sequence: number;
			settings: PromptEnhancementSettings;
			sessionKey?: string;
			projectId?: string;
			generation?: number;
		}[];
	};
	const event = batch.events?.[0];
	if (
		batch.type !== "events" ||
		event?.type !== "prompt_enhancement_settings_changed" ||
		event.sequence !== sequence ||
		event.sessionKey != null ||
		event.projectId != null ||
		event.generation != null
	) {
		throw new Error(
			`unexpected prompt enhancement event: ${JSON.stringify(batch)}`,
		);
	}
	expectSnapshot(event.settings, saved);
	return saved;
}

async function run() {
	const fixture = new BootstrapFixture();
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		const { latestSequence: eventSequence } = await hostClient.bootstrap();
		const enabled = await save(pilo, true, model, 0, eventSequence + 1);
		await expectError(
			hostClient.savePromptEnhancementSettings("local", true, {
				...model,
				id: " ",
			}),
			"enhancement model provider and id must be nonempty and within limits",
		);
		await expectError(
			hostClient.savePromptEnhancementSettings("local", true, {
				provider: "fixture",
			} as never),
			"missing field",
		);
		await expectError(
			hostClient.savePromptEnhancementSettings("missing", false, null),
			"Connection 'missing' was not found",
		);
		expectSnapshot(
			await hostClient.loadPromptEnhancementSettings("local"),
			enabled,
		);
		const disabled = await save(
			pilo,
			false,
			model,
			enabled.updatedAtMs,
			eventSequence + 2,
		);
		const inherited = await save(
			pilo,
			true,
			null,
			disabled.updatedAtMs,
			eventSequence + 3,
		);

		await pilo.shutdown();
		await expectError(
			hostClient.savePromptEnhancementSettings("local", false, null),
			"Pilo runtime has been shut down",
		);
		const reopened = new Pilo(fixture.dataDir());
		const reopenedClient = createNativeHostClient(reopened);
		try {
			expectSnapshot(
				await reopenedClient.loadPromptEnhancementSettings("local"),
				inherited,
			);
		} finally {
			await reopened.shutdown();
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("prompt enhancement settings saves verified");
}

mount(() => <Text>{status()}</Text>);
void run().catch((error: unknown) => status.set(String(error)));
