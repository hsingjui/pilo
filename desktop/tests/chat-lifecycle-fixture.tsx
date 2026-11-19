import { host, mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

const status = signal("starting Pi");
const projectId = "chat-fixture";
const sessionKey = "nsh-chat-fixture";

type ChatEvent = {
	type: string;
	sessionKey?: string;
	message?: unknown;
	delta?: string;
	text?: string;
};

async function readEvents(pilo: Pilo, handle: (event: ChatEvent) => boolean) {
	for (;;) {
		const batch = (await pilo.nextEvents(32)) as {
			type: string;
			events?: ChatEvent[];
		};
		if (batch.type !== "events")
			throw new Error(`unexpected event batch: ${batch.type}`);
		for (const event of batch.events ?? []) {
			if (event.sessionKey === sessionKey && handle(event)) return;
		}
	}
}

async function smokeTurn(pilo: Pilo, fixture: ChatFixture) {
	await fixture.send(pilo, sessionKey, {
		id: "fixture-model",
		type: "set_model",
		provider: "relay",
		modelId: "deepseek-flash",
	});
	await readEvents(pilo, (event) => {
		if (event.type === "runtime_error") throw new Error(String(event.message));
		if (event.type !== "rpc_message") return false;
		const response = event.message as {
			id?: string;
			success?: boolean;
			error?: string;
		};
		if (response.id !== "fixture-model") return false;
		if (!response.success)
			throw new Error(response.error ?? "set_model failed");
		return true;
	});
	await fixture.send(pilo, sessionKey, {
		id: "fixture-prompt",
		type: "prompt",
		message: "Reply with only this exact text: NSH_BRIDGE_OK",
	});
	let reply = "";
	await readEvents(pilo, (event) => {
		if (event.type === "runtime_error") throw new Error(String(event.message));
		if (event.type === "rpc_message") {
			const response = event.message as {
				id?: string;
				success?: boolean;
				error?: string;
			};
			if (response.id === "fixture-prompt" && !response.success) {
				throw new Error(response.error ?? "prompt failed");
			}
		}
		if (event.type === "assistant_text_delta") reply += event.delta ?? "";
		if (event.type === "assistant_text_snapshot") reply = event.text ?? "";
		return event.type === "assistant_message_end";
	});
	if (reply.trim() !== "NSH_BRIDGE_OK")
		throw new Error(`unexpected reply: ${reply}`);
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

async function expectIdle(pilo: Pilo, generation: number) {
	const state = (await pilo.chatState(sessionKey)) as {
		sessionKey: string;
		projectId: string;
		sessionPath: string | null;
		prepared: boolean;
		initialized: boolean;
		activeTurn: boolean;
		snapshot: { state: string; generation: number };
	} | null;
	if (
		state?.sessionKey !== sessionKey ||
		state.projectId !== projectId ||
		state.sessionPath !== null ||
		state.prepared !== true ||
		state.initialized !== true ||
		state.activeTurn !== false ||
		state.snapshot.state !== "running" ||
		state.snapshot.generation !== generation
	) {
		throw new Error(`unexpected chat state: ${JSON.stringify(state)}`);
	}
}

async function run() {
	const realPi = host.params.realPi === true;
	const state = host.params.state === true;
	const stop = state || host.params.stop === true;
	const fixture = new ChatFixture(realPi);
	const pilo = new Pilo(fixture.dataDir());
	const input = { projectId, sessionKey, noSession: true };
	try {
		if (state && (await pilo.chatState(sessionKey)) !== null) {
			throw new Error("unexpected chat state before startup");
		}
		await expectError(
			pilo.startChat({ ...input, projectId: "missing" }),
			"Project 'missing' was not found",
		);
		const snapshot = (await pilo.startChat(input)) as {
			state: string;
			projectId: string;
			generation: number;
		};
		if (
			snapshot.state !== "running" ||
			snapshot.projectId !== projectId ||
			snapshot.generation <= 0
		) {
			throw new Error(`Pi did not start: ${JSON.stringify(snapshot)}`);
		}
		if (state) await expectIdle(pilo, snapshot.generation);
		if (realPi) {
			await smokeTurn(pilo, fixture);
			if (state) await expectIdle(pilo, snapshot.generation);
		}
		if (stop) {
			await pilo.stopChat(sessionKey, "fixture complete");
			await expectError(
				fixture.send(pilo, sessionKey, { type: "get_state" }),
				"is not running",
			);
			await pilo.stopChat(sessionKey);
			if (state && (await pilo.chatState(sessionKey)) !== null) {
				throw new Error("chat state remained after stopping Pi");
			}
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	await expectError(pilo.startChat(input), "Pilo runtime has been shut down");
	if (stop) {
		await expectError(
			pilo.stopChat(sessionKey),
			"Pilo runtime has been shut down",
		);
	}
	if (state) {
		await expectError(
			pilo.chatState(sessionKey),
			"Pilo runtime has been shut down",
		);
	}
	const method = state ? "chatState" : stop ? "stopChat" : "startChat";
	status.set(
		realPi
			? `${method}: relay/deepseek-flash replied NSH_BRIDGE_OK`
			: `${method} verified`,
	);
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
