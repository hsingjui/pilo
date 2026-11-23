import { host, mount, signal, Text } from "nsh";
import { ChatFixture, Pilo } from "app/native";
import type { PiloRuntimeEvent } from "@shared/api/pi-runtime-types";
import type { SessionHistoryResult } from "@shared/api/sessions-types";
import type { ConversationEvent } from "@shared/chat/conversation-types";

const key = "nsh-transcript-snapshot";
const status = signal("checking transcript snapshots");
type Event = PiloRuntimeEvent & { sequence: number };
type Snapshot = {
	eventSequence: number;
	sessionKey: string;
	generation: number;
	history: SessionHistoryResult;
	live:
		| { type: "idle" | "truncated" }
		| { type: "active"; events: PiloRuntimeEvent[] };
};

async function waitFor(
	pilo: Pilo,
	sessionKey: string,
	stop: (event: Event) => boolean,
) {
	for (;;) {
		const batch = (await pilo.nextEvents(1)) as {
			type: string;
			events?: Event[];
		};
		if (batch.type !== "events")
			throw new Error(`unexpected event batch: ${batch.type}`);
		const event = batch.events?.[0];
		if (!event || event.sessionKey !== sessionKey) continue;
		if (event.type === "runtime_error") throw new Error(event.message);
		if (stop(event)) return event;
	}
}

async function start(
	pilo: Pilo,
	sessionKey: string,
	sessionPath?: string,
	noSession = false,
) {
	const snapshot = (await pilo.startChat({
		projectId: "chat-fixture",
		sessionKey,
		sessionPath,
		noSession,
	})) as { state: string; generation: number };
	if (snapshot.state !== "running") throw new Error("Pi did not start");
	return snapshot.generation;
}

async function snapshot(
	pilo: Pilo,
	sessionKey: string,
	generation: number,
	window?: unknown,
) {
	const result = (await pilo.chatTranscriptSnapshot(
		sessionKey,
		window,
	)) as Snapshot;
	if (
		result.sessionKey !== sessionKey ||
		result.generation !== generation ||
		!Number.isSafeInteger(result.eventSequence)
	) {
		throw new Error("snapshot identity or event cut did not match the session");
	}
	return result;
}

function seed(fixture: ChatFixture) {
	const seed = {
		type: "message",
		id: "prior-user",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: "saved question" },
	};
	return fixture.seedTranscript(`${JSON.stringify(seed)}\n`);
}

async function loadThenStart(pilo: Pilo, fixture: ChatFixture) {
	const path = seed(fixture);
	const settled = (await pilo.loadHistory(
		"chat-fixture",
		path,
	)) as SessionHistoryResult;
	if (
		!settled.fingerprint ||
		!settled.history.events.some(
			(event) =>
				event.type === "user_message_start" && event.text === "saved question",
		)
	) {
		throw new Error(`unexpected settled history: ${JSON.stringify(settled)}`);
	}
	await start(pilo, key, path);
}

async function fake(pilo: Pilo, fixture: ChatFixture) {
	const path = seed(fixture);
	const generation = await start(pilo, key, path);
	const idle = await snapshot(pilo, key, generation, {
		messageLimit: 1,
		includeMessageIndex: true,
	});
	const history = idle.history.history;
	if (
		idle.live.type !== "idle" ||
		!idle.history.fingerprint ||
		history.messageIndex?.length !== 1 ||
		!history.events.some(
			(event) =>
				event.type === "user_message_start" && event.text === "saved question",
		)
	) {
		throw new Error(`unexpected idle snapshot: ${JSON.stringify(idle)}`);
	}
	async function promptAndWait(sessionKey: string) {
		await pilo.sendChatCommand(sessionKey, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
		return waitFor(
			pilo,
			sessionKey,
			(event) => event.type === "assistant_text_delta",
		);
	}
	const delta = await promptAndWait(key);
	const active = await snapshot(pilo, key, generation);
	if (
		active.live.type !== "active" ||
		active.eventSequence < delta.sequence ||
		JSON.stringify(active.history.history.events) !==
			JSON.stringify(history.events) ||
		!active.live.events.some(
			(event) =>
				event.type === "user_message_start" && event.text === "new question",
		) ||
		!active.live.events.some(
			(event) =>
				event.type === "assistant_text_delta" &&
				event.delta === "partial reply",
		)
	) {
		throw new Error(`unexpected active snapshot: ${JSON.stringify(active)}`);
	}
	await pilo.stopChat(key);

	const unsavedKey = `${key}-unsaved`;
	const unsavedGeneration = await start(pilo, unsavedKey, undefined, true);
	const unsavedDelta = await promptAndWait(unsavedKey);
	const truncated = await snapshot(pilo, unsavedKey, unsavedGeneration);
	if (
		truncated.live.type !== "truncated" ||
		truncated.eventSequence < unsavedDelta.sequence ||
		truncated.history.fingerprint !== null ||
		truncated.history.history.events.length !== 0
	) {
		throw new Error(
			`unexpected truncated snapshot: ${JSON.stringify(truncated)}`,
		);
	}
}

function plainTranscript(events: (ConversationEvent | PiloRuntimeEvent)[]) {
	const messages: { role: "user" | "assistant"; text: string }[] = [];
	for (const event of events) {
		switch (event.type) {
			case "user_message_start":
				messages.push({ role: "user", text: event.text });
				break;
			case "assistant_message_start":
				messages.push({ role: "assistant", text: "" });
				break;
			case "assistant_text_delta":
			case "assistant_text_snapshot": {
				const message = messages.at(-1);
				if (message?.role !== "assistant")
					throw new Error("assistant text outside a message");
				message.text =
					event.type === "assistant_text_snapshot"
						? event.text
						: message.text + event.delta;
				break;
			}
			case "tool_execution_start":
			case "assistant_thinking_delta":
				throw new Error("expected a plain-text Pi turn");
		}
	}
	return messages;
}

async function real(pilo: Pilo) {
	const generation = await start(pilo, key);
	async function checkedCommand(
		type: string,
		fields: Record<string, unknown> = {},
	) {
		await pilo.sendChatCommand(key, { ...fields, type, id: type });
		const event = await waitFor(
			pilo,
			key,
			(event) =>
				event.type === "rpc_message" &&
				(event.message as { id?: string }).id === type,
		);
		if (event.type !== "rpc_message")
			throw new Error(`missing ${type} response`);
		const response = event.message as {
			success: boolean;
			error?: string;
			data?: { sessionFile?: string };
		};
		if (!response.success) throw new Error(response.error ?? `${type} failed`);
		return response.data;
	}
	await checkedCommand("set_model", {
		provider: "relay",
		modelId: "deepseek-flash",
	});
	await checkedCommand("set_thinking_level", { level: "off" });
	await checkedCommand("prompt", {
		message: "Reply only with TRANSCRIPT_BASE.",
	});
	await waitFor(pilo, key, (event) => event.type === "assistant_message_end");
	if (!(await checkedCommand("get_state"))?.sessionFile)
		throw new Error("Pi did not save a session");
	const base = await snapshot(pilo, key, generation);
	if (
		base.live.type !== "idle" ||
		!base.history.fingerprint ||
		!plainTranscript(base.history.history.events).some((message) =>
			message.text.includes("TRANSCRIPT_BASE"),
		)
	) {
		throw new Error("the first real Pi turn was not in settled history");
	}
	await checkedCommand("prompt", {
		message:
			"Write exactly 50 numbered lines of plain text, each about a different imaginary bakery. Give each line one short complete sentence. No tools, explanations or markdown fences.",
	});
	await waitFor(pilo, key, (event) => event.type === "assistant_text_delta");
	const cut = await snapshot(pilo, key, generation);
	if (
		cut.live.type !== "active" ||
		!cut.live.events.some((event) => event.type === "assistant_text_delta")
	) {
		throw new Error(
			`the real Pi cut did not capture live text (live: ${cut.live.type})`,
		);
	}
	const later: Event[] = [];
	await waitFor(pilo, key, (event) => {
		if (
			!("generation" in event) ||
			event.generation !== generation ||
			event.sequence <= cut.eventSequence
		)
			return false;
		later.push(event);
		return event.type === "assistant_message_end";
	});
	if (!later.some((event) => event.type === "assistant_text_delta")) {
		throw new Error(
			"no later assistant text was observed above the real Pi cut",
		);
	}
	const fresh = await snapshot(pilo, key, generation);
	const expected = plainTranscript(fresh.history.history.events);
	const replayed = plainTranscript([
		...cut.history.history.events,
		...cut.live.events,
		...later,
	]);
	if (
		fresh.live.type !== "idle" ||
		expected.length !== 4 ||
		JSON.stringify(expected) !== JSON.stringify(replayed)
	) {
		throw new Error(
			"history + live + later events differed from fresh settled history",
		);
	}
}

async function run() {
	const realPi = host.params.realPi === true;
	const loadHistoryFirst = host.params.loadHistoryFirst === true;
	const fixture = new ChatFixture(realPi);
	const pilo = new Pilo(fixture.dataDir());
	try {
		if (realPi) await real(pilo);
		else if (loadHistoryFirst) await loadThenStart(pilo, fixture);
		else await fake(pilo, fixture);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	status.set(
		realPi
			? "relay/deepseek-flash: history + live + later events matched fresh history"
			: loadHistoryFirst
				? "seeded session history loaded and chat started"
				: "idle, active and truncated transcript snapshots verified",
	);
}

mount(() => <Text>{status()}</Text>);
void run().catch((error: unknown) => status.set(String(error)));
