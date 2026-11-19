// The M0 spike's state: the existing Rust runtime (`Pilo`, `app/native`)
// feeding the shared conversation reducer (`src/lib/chat`).
import { batch, signal } from "nsh";
import { Pilo } from "app/native";

import {
	createConversationState,
	reduceConversation,
} from "@/lib/chat/conversation-reducer";
import { toConversationAction } from "@/lib/chat/conversation-runtime-adapter";
import type { ConversationState } from "@/lib/chat/conversation-types";

import { reducerContext } from "./reducer-context";

export interface Project {
	readonly id: string;
	readonly name: string;
	readonly path: string;
}

export interface Session {
	readonly sessionPath: string;
	readonly name: string | null;
	readonly firstUserMessagePreview: string | null;
	readonly messageCount: number;
	readonly updatedAt: string;
}

/** What the event pump measured since the last reset. */
export interface Delivery {
	/** Runtime events delivered to JS. */
	readonly events: number;
	/** `nextEvents()` round trips that carried them. */
	readonly batches: number;
	/** Rust read → JS receive, in milliseconds. */
	readonly p50: number;
	readonly p95: number;
	readonly max: number;
	/** JS receive → reducer and signals written, per batch, in milliseconds. */
	readonly reduceP95: number;
}

interface RuntimeEvent {
	readonly type: string;
	readonly sessionKey?: string;
	readonly rustUs: number;
	readonly [field: string]: unknown;
}

const pilo = new Pilo();
const context = reducerContext();

export const projects = signal<Project[]>(pilo.projects() as Project[]);
export const projectId = signal<string | null>(projects()[0]?.id ?? null);
export const sessions = signal<Session[]>(readSessions());
export const conversation = signal<ConversationState>(
	createConversationState(),
);
export const status = signal("idle");
export const delivery = signal<Delivery | null>(null);
/** What the last failed call to the runtime said. */
export const failure = signal<string | null>(null);

let sessionKey: string | null = null;
let chats = 0;
let latencies: number[] = [];
let reduceCosts: number[] = [];
let batches = 0;

function readSessions(): Session[] {
	const id = projectId();
	return id ? (pilo.sessions(id) as Session[]) : [];
}

export function selectProject(id: string) {
	batch(() => {
		projectId.set(id);
		sessions.set(readSessions());
	});
}

function quantile(sorted: number[], q: number): number {
	return sorted.length
		? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
		: 0;
}

function publishDelivery() {
	const sorted = [...latencies].sort((a, b) => a - b);
	const costs = [...reduceCosts].sort((a, b) => a - b);
	delivery.set({
		events: sorted.length,
		batches,
		p50: quantile(sorted, 0.5) / 1000,
		p95: quantile(sorted, 0.95) / 1000,
		max: (sorted[sorted.length - 1] ?? 0) / 1000,
		reduceP95: quantile(costs, 0.95) / 1000,
	});
}

export function resetDelivery() {
	latencies = [];
	reduceCosts = [];
	batches = 0;
	delivery.set(null);
}

// What the events reduced to since the last frame: written to the signals
// once per display frame, however many batches arrived in it.
let pending: ConversationState | null = null;
let pendingTurnEnded = false;
let frame = 0;

function flush() {
	frame = 0;
	const state = pending;
	const turnEnded = pendingTurnEnded;
	pending = null;
	pendingTurnEnded = false;
	batch(() => {
		if (state) conversation.set(state);
		if (turnEnded) {
			status.set("idle");
			sessions.set(readSessions());
		}
		publishDelivery();
	});
}

async function pump() {
	for (;;) {
		const events = (await pilo.nextEvents()) as RuntimeEvent[];
		if (!events.length) return;
		const received = Pilo.nowUs();
		let state = pending ?? conversation();
		for (const event of events) {
			latencies.push(received - event.rustUs);
			if (event.sessionKey !== sessionKey) continue;
			if (event.type === "process_state") status.set(String(event.state));
			const action = toConversationAction(event);
			if (action) state = reduceConversation(state, action, context);
			pendingTurnEnded ||= event.type === "assistant_message_end";
		}
		batches += 1;
		pending = state;
		reduceCosts.push(Pilo.nowUs() - received);
		frame ||= requestAnimationFrame(flush);
	}
}
void pump();

function submit(text: string) {
	let state = reduceConversation(
		pending ?? conversation(),
		{
			type: "local_user_submit",
			clientMessageId: `local-${Date.now()}`,
			text,
			timestampMs: Date.now(),
		},
		context,
	);
	state = reduceConversation(
		state,
		{ type: "local_assistant_pending", timestampMs: Date.now() },
		context,
	);
	pending = null;
	conversation.set(state);
}

/** Sends `text` to Pi in the selected project, starting the chat first. */
export async function send(text: string, sessionPath?: string) {
	const project = projectId();
	if (!project || !text.trim()) return;
	failure.set(null);
	try {
		if (!sessionKey) {
			status.set("starting");
			const key = JSON.stringify([
				project,
				`nsh-spike-${Date.now()}-${++chats}`,
			]);
			sessionKey = key;
			await pilo.startChat(project, key, sessionPath ?? null);
		}
		resetDelivery();
		submit(text);
		status.set("streaming");
		await pilo.prompt(sessionKey, text);
	} catch (error) {
		sessionKey = null;
		failure.set(String(error));
	}
}

/** A synthetic reply of `count` deltas, `perSecond` a second, on the runtime's bus. */
export async function burst(count: number, perSecond: number) {
	// The bus needs no project: an empty data directory can be measured too.
	const project = projectId() ?? "nsh-spike";
	sessionKey ??= JSON.stringify([project, `nsh-spike-burst-${Date.now()}`]);
	resetDelivery();
	submit(`burst ${count} @ ${perSecond}/s`);
	status.set("streaming");
	await pilo.emitTextBurst(sessionKey, project, count, perSecond);
}

/** Stops the chat's Pi process and clears the conversation. */
export async function reset() {
	const key = sessionKey;
	sessionKey = null;
	pending = null;
	batch(() => {
		conversation.set(createConversationState());
		status.set("idle");
	});
	resetDelivery();
	if (key) await pilo.stopChat(key).catch(() => {});
}
