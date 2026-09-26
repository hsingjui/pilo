import { useEffect, useState } from "react";

import type { ConversationReducerContext } from "@/lib/conversation-types";
import type { SessionIndexEntry } from "@/lib/sessions";
import { randomId } from "@/lib/utils";

export type RpcResponse<T = unknown> = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: T;
	error?: string;
};

export const reducerContext: ConversationReducerContext = {
	createMessageId: (kind) => kind + "-" + randomId(),
	createContentId: (kind) => kind + "-" + randomId(),
	now: () => Date.now(),
	formatTime: (timestampMs) =>
		new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(timestampMs)),
};

export function sessionLabel(session: SessionIndexEntry) {
	return (
		session.titleOverride ||
		session.name ||
		session.firstUserMessagePreview ||
		"Untitled session"
	);
}

export function sessionKey(projectId: string, id: string) {
	return JSON.stringify([projectId, id]);
}

export function isRpcResponse(value: unknown): value is RpcResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "response"
	);
}

export function useMediaQuery(query: string) {
	const [matches, setMatches] = useState(
		() => typeof window !== "undefined" && window.matchMedia(query).matches,
	);
	useEffect(() => {
		const media = window.matchMedia(query);
		const onChange = () => setMatches(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

export type RetryState = {
	kind: "agent" | "summary";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
};

// Scroll position survives session switches and reloads without a Host round trip.
export const REMOTE_SCROLL_KEY_PREFIX = "pilo.remote.scroll.v1.";

export function remoteScrollKey(routeSessionKey: string | null) {
	return REMOTE_SCROLL_KEY_PREFIX + (routeSessionKey ?? "draft");
}

export function readRemoteScrollState(routeSessionKey: string | null) {
	try {
		const raw = window.localStorage.getItem(remoteScrollKey(routeSessionKey));
		if (!raw) return { scrollTop: 0, sticky: true };
		const parsed = JSON.parse(raw) as {
			scrollTop?: unknown;
			sticky?: unknown;
		};
		return {
			scrollTop: typeof parsed.scrollTop === "number" ? parsed.scrollTop : 0,
			sticky: typeof parsed.sticky === "boolean" ? parsed.sticky : true,
		};
	} catch {
		return { scrollTop: 0, sticky: true };
	}
}

export function writeRemoteScrollState(
	routeSessionKey: string | null,
	state: { scrollTop: number; sticky: boolean },
) {
	try {
		window.localStorage.setItem(
			remoteScrollKey(routeSessionKey),
			JSON.stringify(state),
		);
	} catch {
		// Best-effort persistence; ignore quota or private-mode failures.
	}
}
