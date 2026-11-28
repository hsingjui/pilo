import { host, mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";
import { createNativeHostClient } from "../client/native-transport";

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

async function smokeTurn(pilo: Pilo) {
	const hostClient = createNativeHostClient(pilo);
	await hostClient.sendChatCommand(sessionKey, {
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
	await hostClient.sendChatCommand(sessionKey, {
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

async function expectCommandResponse(pilo: Pilo) {
	const hostClient = createNativeHostClient(pilo);
	await hostClient.sendChatCommand(sessionKey, {
		id: "fixture-probe",
		type: "get_state",
		probe: { values: [true, 42, "native"] },
	});
	await readEvents(pilo, (event) => {
		if (event.type !== "rpc_message") return false;
		const response = event.message as {
			id?: string;
			command?: string;
			success?: boolean;
			data?: { values?: unknown[] };
		};
		if (response.id !== "fixture-probe") return false;
		if (
			response.command !== "get_state" ||
			response.success !== true ||
			JSON.stringify(response.data?.values) !== '[true,42,"native"]'
		) {
			throw new Error(
				`unexpected command response: ${JSON.stringify(response)}`,
			);
		}
		return true;
	});
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
	const hostClient = createNativeHostClient(pilo);
	const state = (await hostClient.chatState(sessionKey)) as {
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
	const command = host.params.command === true;
	const state = command || host.params.state === true;
	const stop = state || host.params.stop === true;
	const fixture = new ChatFixture(realPi);
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	const input = { projectId, sessionKey, noSession: true };
	try {
		if (state && (await hostClient.chatState(sessionKey)) !== null) {
			throw new Error("unexpected chat state before startup");
		}
		await expectError(
			hostClient.startChat({ ...input, projectId: "missing" }),
			"Project 'missing' was not found",
		);
		const snapshot = (await hostClient.startChat(input)) as {
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
			await smokeTurn(pilo);
			if (state) await expectIdle(pilo, snapshot.generation);
		} else if (command) {
			await expectCommandResponse(pilo);
		}
		if (stop) {
			await hostClient.stopChat(sessionKey, "fixture complete");
			await expectError(
				hostClient.sendChatCommand(sessionKey, { type: "get_state" }),
				"is not running",
			);
			await hostClient.stopChat(sessionKey);
			if (state && (await hostClient.chatState(sessionKey)) !== null) {
				throw new Error("chat state remained after stopping Pi");
			}
		}
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	await expectError(
		hostClient.startChat(input),
		"Pilo runtime has been shut down",
	);
	if (stop) {
		await expectError(
			hostClient.stopChat(sessionKey),
			"Pilo runtime has been shut down",
		);
	}
	if (state) {
		await expectError(
			hostClient.chatState(sessionKey),
			"Pilo runtime has been shut down",
		);
	}
	if (command) {
		await expectError(
			hostClient.sendChatCommand(sessionKey, { type: "get_state" }),
			"Pilo runtime has been shut down",
		);
	}
	const method = command
		? "sendChatCommand"
		: state
			? "chatState"
			: stop
				? "stopChat"
				: "startChat";
	status.set(
		realPi
			? `${method}: relay/deepseek-flash replied NSH_BRIDGE_OK`
			: `${method} verified`,
	);
}

async function shutdownMidTurn() {
	const fixture = new ChatFixture(false);
	const pilo = new Pilo(fixture.dataDir());
	const hostClient = createNativeHostClient(pilo);
	try {
		await hostClient.startChat({ projectId, sessionKey, noSession: true });
		await hostClient.sendChatCommand(sessionKey, {
			id: "fixture-shutdown",
			type: "prompt",
			message: "Keep the turn open",
		});
		await readEvents(pilo, (event) => {
			if (event.type !== "rpc_message") return false;
			const response = event.message as { id?: string; success?: boolean };
			return response.id === "fixture-shutdown" && response.success === true;
		});
		const state = (await hostClient.chatState(sessionKey)) as {
			activeTurn?: boolean;
		} | null;
		if (state?.activeTurn !== true || !fixture.piRunning()) {
			throw new Error("fixture Pi was not alive in an active turn");
		}
		const pending = pilo.nextEvents(32);
		await pilo.shutdown();
		const batch = (await pending) as { type: string };
		if (batch.type !== "closed" || fixture.piRunning()) {
			throw new Error(
				"shutdown did not close the stream and stop the Pi child",
			);
		}
		await expectError(
			hostClient.chatState(sessionKey),
			"Pilo runtime has been shut down",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set("shutdown stops Pi mid-turn");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

const verify = host.params.shutdown === true ? shutdownMidTurn : run;
void verify().catch((error: unknown) => status.set(String(error)));
