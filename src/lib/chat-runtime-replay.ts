import {
	replayChatRuntimeTrace,
	type ChatRuntimeTraceEntry,
} from "./chat-runtime-trace.ts";
import type { PiloRuntimeEvent } from "@/lib/pi-runtime";

export type ChatRuntimeReplayTargetInfo = {
	key: string;
	projectId: string;
	sessionId: string;
	active: boolean;
	busy: boolean;
};

export type ChatRuntimeReplayOptions = {
	speed?: number;
	sessionMap?: Record<string, string>;
	resetTargets?: boolean;
	signal?: AbortSignal;
};

type ChatRuntimeReplayTarget = {
	projectId: string;
	sessionId: string;
	isActive: () => boolean;
	isBusy: () => boolean;
	dispatchEvent: (event: PiloRuntimeEvent) => void;
	flush: () => void;
	reset: () => void;
};

const targets = new Map<string, ChatRuntimeReplayTarget>();

export function chatRuntimeReplayTargetKey(
	projectId: string,
	sessionId: string,
) {
	return JSON.stringify([projectId, sessionId]);
}

export function registerChatRuntimeReplayTarget(
	target: ChatRuntimeReplayTarget,
) {
	const key = chatRuntimeReplayTargetKey(target.projectId, target.sessionId);
	targets.set(key, target);
	return () => {
		if (targets.get(key) === target) targets.delete(key);
	};
}

export function listChatRuntimeReplayTargets(): ChatRuntimeReplayTargetInfo[] {
	return Array.from(targets, ([key, target]) => ({
		key,
		projectId: target.projectId,
		sessionId: target.sessionId,
		active: target.isActive(),
		busy: target.isBusy(),
	}));
}

function resolveReplayTarget(sourceSessionId: string, mappedTarget?: string) {
	const requested = mappedTarget ?? sourceSessionId;
	const direct = targets.get(requested);
	if (direct) return { key: requested, target: direct };

	const matches = Array.from(targets.entries()).filter(
		([, target]) => target.sessionId === requested,
	);
	if (matches.length === 1) {
		const [key, target] = matches[0];
		return { key, target };
	}
	if (matches.length === 0) {
		throw new Error(`No mounted chat replay target matches "${requested}".`);
	}
	throw new Error(
		`Multiple mounted chat replay targets match session "${requested}"; use a target key from targets().`,
	);
}

function targetForEntry(
	entry: ChatRuntimeTraceEntry,
	sessionMap?: Record<string, string>,
) {
	return resolveReplayTarget(entry.sessionId, sessionMap?.[entry.sessionId]);
}

export async function replayChatRuntimeTraceToUi(
	entries: readonly ChatRuntimeTraceEntry[],
	options: ChatRuntimeReplayOptions = {},
) {
	const usedTargets = new Map<string, ChatRuntimeReplayTarget>();
	for (const entry of entries) {
		const resolved = targetForEntry(entry, options.sessionMap);
		usedTargets.set(resolved.key, resolved.target);
	}

	for (const target of usedTargets.values()) {
		if (target.isBusy()) {
			throw new Error(
				`Cannot replay into busy session "${target.sessionId}" while a live runtime turn is active.`,
			);
		}
	}

	if (options.resetTargets) {
		for (const target of usedTargets.values()) target.reset();
	}

	await replayChatRuntimeTrace(
		entries,
		(entry) => {
			const { target } = targetForEntry(entry, options.sessionMap);
			if (target.isBusy()) {
				throw new Error(
					`Replay target "${target.sessionId}" became busy during replay.`,
				);
			}
			target.dispatchEvent(entry.event);
		},
		{ speed: options.speed, signal: options.signal },
	);

	for (const target of usedTargets.values()) target.flush();
}
