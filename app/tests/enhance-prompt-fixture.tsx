import { host, mount, signal, Text } from "nsh";
import { ChatFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

const status = signal("checking prompt enhancement");
const project = "chat-fixture";
const model = (id: string) => ({ provider: "fixture", id });

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
	const realPi = host.params.realPi === true;
	const fixture = new ChatFixture(realPi);
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		if (realPi) {
			await hostClient.savePromptEnhancementSettings("local", true, null);
			const draft =
				"parser unit test pls. Keep PILO_ENHANCE_42 verbatim. Don't edit production files.";
			const rewritten = await hostClient.enhancePrompt(project, draft, {
				provider: "relay",
				id: "deepseek-flash",
			});
			if (
				rewritten === draft ||
				!rewritten.includes("PILO_ENHANCE_42") ||
				!/parser/i.test(rewritten) ||
				rewritten.startsWith("```")
			) {
				throw new Error(`unexpected Pi rewrite: ${JSON.stringify(rewritten)}`);
			}
			return "relay/deepseek-flash rewrote a draft through enhancePrompt";
		}

		await expectError(
			hostClient.enhancePrompt(project, "  ", null),
			"Draft is empty",
		);
		await expectError(
			hostClient.enhancePrompt(project, "rewrite this", null),
			"Prompt enhancement is disabled",
		);

		await hostClient.savePromptEnhancementSettings(
			"local",
			true,
			model("rewrite"),
		);
		const configured = await hostClient.enhancePrompt(
			project,
			"  rewrite this  ",
			model("chat"),
		);
		if (configured !== "rewrite: rewrite this") {
			throw new Error(`unexpected configured-model rewrite: ${configured}`);
		}
		await hostClient.savePromptEnhancementSettings("local", true, null);
		const fallback = await hostClient.enhancePrompt(
			project,
			"rewrite this",
			model("chat"),
		);
		if (fallback !== "chat: rewrite this") {
			throw new Error(`unexpected chat-model rewrite: ${fallback}`);
		}
		await expectError(
			hostClient.enhancePrompt(project, "rewrite this", model(" ")),
			"Invalid enhancement model",
		);
		await expectError(
			hostClient.enhancePrompt(project, "rewrite this", model("unavailable")),
			"Model fixture/unavailable is unavailable",
		);
		await expectError(
			hostClient.enhancePrompt(project, "empty rewrite", model("chat")),
			"Model returned no prompt text",
		);
		await expectError(
			hostClient.enhancePrompt(project, "fail generation", model("chat")),
			"fixture generation failed",
		);
		return "prompt enhancement verified";
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
}

mount(() => <Text>{status()}</Text>);
void run().then(status.set, (error: unknown) => status.set(String(error)));
