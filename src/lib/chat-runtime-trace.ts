import type { PiloRuntimeEvent } from "@/lib/pi-runtime";

export type ChatRuntimeTraceEntry = {
	t: number;
	sessionId: string;
	event: PiloRuntimeEvent;
};

export type ChatRuntimeTraceReplayOptions = {
	speed?: number;
	signal?: AbortSignal;
	sleep?: (delayMs: number) => Promise<void>;
};

function normalizeTimestamp(value: number) {
	return Math.max(0, Math.round(value * 1000) / 1000);
}

function assertReplaySpeed(speed: number) {
	if (!Number.isFinite(speed) || speed <= 0) {
		throw new Error(
			"Runtime trace replay speed must be a finite number greater than 0.",
		);
	}
}

function isRuntimeEvent(value: unknown): value is PiloRuntimeEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	return typeof event.type === "string" && Number.isFinite(event.generation);
}

export class ChatRuntimeTraceRecorder {
	private startedAt: number | null = null;
	private entries: ChatRuntimeTraceEntry[] = [];

	start(now = performance.now()) {
		this.entries = [];
		this.startedAt = now;
	}

	stop() {
		this.startedAt = null;
		return this.snapshot();
	}

	clear() {
		this.startedAt = null;
		this.entries = [];
	}

	get recording() {
		return this.startedAt !== null;
	}

	record(sessionId: string, event: PiloRuntimeEvent, now = performance.now()) {
		if (this.startedAt === null) return;
		this.entries.push({
			t: normalizeTimestamp(now - this.startedAt),
			sessionId,
			event: structuredClone(event),
		});
	}

	snapshot() {
		return this.entries.map((entry) => structuredClone(entry));
	}
}

const runtimeTraceRecorder = new ChatRuntimeTraceRecorder();

export function startChatRuntimeTraceRecording(now?: number) {
	runtimeTraceRecorder.start(now);
}

export function stopChatRuntimeTraceRecording() {
	return runtimeTraceRecorder.stop();
}

export function clearChatRuntimeTraceRecording() {
	runtimeTraceRecorder.clear();
}

export function getChatRuntimeTraceRecording() {
	return runtimeTraceRecorder.snapshot();
}

export function isChatRuntimeTraceRecording() {
	return runtimeTraceRecorder.recording;
}

export function recordChatRuntimeTraceEvent(
	sessionId: string,
	event: PiloRuntimeEvent,
	now?: number,
) {
	runtimeTraceRecorder.record(sessionId, event, now);
}

export function serializeChatRuntimeTrace(
	entries: readonly ChatRuntimeTraceEntry[],
) {
	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

export function parseChatRuntimeTrace(source: string) {
	const entries: ChatRuntimeTraceEntry[] = [];
	const lines = source.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`Invalid runtime trace JSON on line ${index + 1}`);
		}
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid runtime trace entry on line ${index + 1}`);
		}
		const entry = value as Record<string, unknown>;
		if (
			!Number.isFinite(entry.t) ||
			Number(entry.t) < 0 ||
			typeof entry.sessionId !== "string" ||
			!entry.sessionId ||
			!isRuntimeEvent(entry.event)
		) {
			throw new Error(`Invalid runtime trace entry on line ${index + 1}`);
		}
		entries.push({
			t: normalizeTimestamp(Number(entry.t)),
			sessionId: entry.sessionId,
			event: entry.event,
		});
	}
	return entries;
}

export async function replayChatRuntimeTrace(
	entries: readonly ChatRuntimeTraceEntry[],
	dispatch: (entry: ChatRuntimeTraceEntry) => void | Promise<void>,
	options: ChatRuntimeTraceReplayOptions = {},
) {
	const speed = options.speed ?? 1;
	assertReplaySpeed(speed);
	const sleep =
		options.sleep ??
		((delayMs: number) =>
			new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));
	let previousTimestamp = 0;
	await entries.reduce<Promise<void>>(async (pending, entry) => {
		await pending;
		if (options.signal?.aborted) return;
		const delayMs = Math.max(0, entry.t - previousTimestamp) / speed;
		if (delayMs > 0) await sleep(delayMs);
		if (options.signal?.aborted) return;
		await dispatch(structuredClone(entry));
		previousTimestamp = entry.t;
	}, Promise.resolve());
}
