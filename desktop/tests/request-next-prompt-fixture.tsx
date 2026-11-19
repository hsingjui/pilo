import { host, mount, signal, Text } from "nsh";
import { ChatFixture, Pilo } from "app/native";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime-types";
import { decodeNextPromptResult } from "@/lib/next-prompt";

const sessionKey = "nsh-next-prompt-fixture";
const status = signal("checking next-prompt request");

async function waitForEvent(
	pilo: Pilo,
	matches: (event: PiloRuntimeEvent) => boolean,
) {
	for (;;) {
		const batch = (await pilo.nextEvents(1)) as {
			type: string;
			events?: PiloRuntimeEvent[];
		};
		if (batch.type !== "events")
			throw new Error(`unexpected event batch: ${batch.type}`);
		for (const event of batch.events ?? []) {
			if (event.sessionKey !== sessionKey) continue;
			if (event.type === "runtime_error")
				throw new Error(JSON.stringify(event));
			if (matches(event)) return event;
		}
	}
}

async function rpcResponse(pilo: Pilo, id: string) {
	const event = await waitForEvent(
		pilo,
		(event) =>
			event.type === "rpc_message" &&
			(event.message as { id?: string }).id === id,
	);
	if (event.type !== "rpc_message") throw new Error("missing RPC response");
	const response = event.message as {
		success?: boolean;
		data?: unknown;
		error?: string;
	};
	if (!response.success) throw new Error(response.error ?? `RPC ${id} failed`);
	return response.data;
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

const isReady = (event: PiloRuntimeEvent) =>
	event.type === "extension_ui_request" &&
	event.widgetKey === "pilo.next-prompt.ready.v1";

async function run() {
	const real = host.params.realPi === true;
	const fixture = new ChatFixture(real);
	const pilo = new Pilo(fixture.dataDir());
	try {
		const model = {
			provider: real ? "relay" : "fixture",
			id: real ? "deepseek-flash" : "naming",
		};
		const settings = (await pilo.saveNextPromptSettings(
			"local",
			true,
			model,
		)) as { updatedAtMs: number };
		const request = {
			sessionKey,
			sessionId: "fixture-session",
			requestId: "fixture-predict",
			generation: 0,
			revision: settings.updatedAtMs,
		};
		if (!real) {
			await expectError(
				pilo.requestNextPrompt(request),
				"prediction session is not running",
			);
			await expectError(
				pilo.requestNextPrompt({ ...request, requestId: "bad id" }),
				"invalid next prompt request identity",
			);
		}
		const started = (await pilo.startChat({
			projectId: "chat-fixture",
			sessionKey,
			noSession: true,
		})) as { state: string; generation: number };
		if (started.state !== "running")
			throw new Error("fixture chat did not start");
		request.generation = started.generation;
		if (!real) {
			await expectError(
				pilo.requestNextPrompt(request),
				"prediction session is no longer idle or available",
			);
			await pilo.sendChatCommand(sessionKey, {
				id: "fixture-next-prompt-ready",
				type: "get_state",
			});
		}
		const ready = await waitForEvent(pilo, isReady);
		if (
			ready.type !== "extension_ui_request" ||
			ready.widgetLines?.[0] !== "ready"
		) {
			throw new Error("Pi next-prompt extension was not ready");
		}

		if (real) {
			await pilo.sendChatCommand(sessionKey, {
				id: "fixture-model",
				type: "set_model",
				provider: model.provider,
				modelId: model.id,
			});
			await rpcResponse(pilo, "fixture-model");
			await pilo.sendChatCommand(sessionKey, {
				id: "fixture-state",
				type: "get_state",
			});
			const state = (await rpcResponse(pilo, "fixture-state")) as {
				sessionId?: string;
			};
			if (!state.sessionId) throw new Error("Pi did not report a session ID");
			request.sessionId = state.sessionId;
			await pilo.sendChatCommand(sessionKey, {
				id: "fixture-turn",
				type: "prompt",
				message:
					"I am learning about sourdough bread. Give one short tip, then ask if I want a starter feeding schedule.",
			});
			await rpcResponse(pilo, "fixture-turn");
			const end = await waitForEvent(
				pilo,
				(event) => event.type === "assistant_message_end",
			);
			if (end.type === "assistant_message_end" && end.errorMessage)
				throw new Error(end.errorMessage);
		} else {
			await expectError(
				pilo.requestNextPrompt({ ...request, revision: request.revision - 1 }),
				"prediction settings changed",
			);
			await expectError(
				pilo.requestNextPrompt({
					...request,
					generation: request.generation + 1,
				}),
				"prediction session is no longer idle or available",
			);
		}

		await pilo.requestNextPrompt(request);
		const event = await waitForEvent(
			pilo,
			(event) => decodeNextPromptResult(event) !== null,
		);
		const result = decodeNextPromptResult(event);
		if (
			event.type !== "extension_ui_request" ||
			result?.requestId !== request.requestId ||
			result.sessionId !== request.sessionId ||
			result.revision !== request.revision ||
			event.generation !== request.generation ||
			result.status !== "ready" ||
			!result.leafId ||
			!result.text ||
			(!real && result.text !== "What comes next?")
		) {
			throw new Error(
				`unexpected next-prompt result: ${JSON.stringify(result)}`,
			);
		}
		if (real)
			return "requestNextPrompt: relay/deepseek-flash published a ready suggestion";

		await pilo.saveNextPromptSettings("local", false, model);
		await pilo.requestNextPrompt({ ...request, cancel: true });
		const cancelled = (await rpcResponse(
			pilo,
			"pilo-next-prompt-fixture-predict-true",
		)) as {
			cancel?: boolean;
			requestId?: string;
			sessionId?: string;
			revision?: number;
		};
		if (
			cancelled.cancel !== true ||
			cancelled.requestId !== request.requestId ||
			cancelled.sessionId !== request.sessionId ||
			cancelled.revision !== request.revision
		) {
			throw new Error("Pi did not receive the matching cancellation");
		}
		return "next-prompt request and cancellation reached Pi";
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
}

mount(() => <Text>{status()}</Text>);
void run().then(
	(message) => status.set(message),
	(error: unknown) => status.set(String(error)),
);
