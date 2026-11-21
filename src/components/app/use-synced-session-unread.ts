import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { chatUiStateKey } from "@/components/app/app-chat-state";
import { useSessionUnread } from "@/components/app/use-session-unread";
import type { SidebarSession } from "@/components/sidebar/types";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { PiloClient } from "@/lib/api/pilo-client";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import type { SessionReadState } from "@/lib/session-read-state";

type Options = {
	client: PiloClient | null;
	refreshKey?: string | number;
	subscribe?: (
		handler: (event: PiloRuntimeEvent) => void,
	) => Promise<() => void>;
	onError?: (error: unknown) => boolean;
};

export function useSyncedSessionUnread(
	sessions: readonly SidebarSession[],
	selectedSessionKey: string | null,
	runtimeStates: readonly ChatSessionRuntimeState[],
	{ client, refreshKey = 0, subscribe, onError }: Options,
) {
	// Sessions without Host completion records retain the existing local
	// behavior; persisted Host records are authoritative.
	const localUnread = useSessionUnread(
		sessions,
		selectedSessionKey,
		runtimeStates,
	);
	const [snapshot, setSnapshot] = useState<{
		client: PiloClient | null;
		states: ReadonlyMap<string, SessionReadState>;
		versions: ReadonlyMap<string, number>;
	}>(() => ({ client, states: new Map(), versions: new Map() }));
	const [visible, setVisible] = useState(
		() => document.visibilityState === "visible" && document.hasFocus(),
	);
	const updateVersionRef = useRef(0);
	const refreshRequestRef = useRef(0);
	const activeClientRef = useRef(client);
	const seenCompletionsRef = useRef(new Set<string>());
	const selectedPathRef = useRef<string | null>(null);
	const selected = sessions.find(
		(session) =>
			chatUiStateKey(session.projectId, session.id) === selectedSessionKey,
	);
	const selectedPathKey = selected?.sessionPath
		? chatUiStateKey(selected.projectId, selected.sessionPath)
		: null;
	useEffect(() => {
		selectedPathRef.current = selectedPathKey;
	}, [selectedPathKey]);
	useEffect(() => {
		activeClientRef.current = client;
		seenCompletionsRef.current.clear();
		return () => {
			activeClientRef.current = null;
		};
	}, [client]);

	const states = useMemo(
		() =>
			snapshot.client === client
				? snapshot.states
				: new Map<string, SessionReadState>(),
		[snapshot, client],
	);
	const reportError = useCallback(
		(error: unknown) => {
			if (!onError?.(error)) {
				console.debug("Failed to synchronize session read state", error);
			}
		},
		[onError],
	);
	const applyStates = useCallback(
		(updates: readonly SessionReadState[], snapshotVersion?: number) => {
			const version = ++updateVersionRef.current;
			setSnapshot((current) => {
				const previous =
					current.client === client
						? current.states
						: new Map<string, SessionReadState>();
				const next = new Map(previous);
				const versions = new Map(
					current.client === client ? current.versions : [],
				);
				let changed = current.client !== client;
				if (snapshotVersion !== undefined) {
					const keys = new Set(
						updates.map((state) =>
							chatUiStateKey(state.projectId, state.sessionPath),
						),
					);
					for (const key of next.keys()) {
						// Full snapshots remove deleted records, but not live updates
						// received after this snapshot request started.
						if (!keys.has(key) && (versions.get(key) ?? 0) <= snapshotVersion) {
							next.delete(key);
							versions.delete(key);
							changed = true;
						}
					}
				}
				for (const update of updates) {
					const key = chatUiStateKey(update.projectId, update.sessionPath);
					const old = next.get(key);
					// HTTP replies, snapshots and replay may arrive out of order.
					const completedRevision = Math.max(
						old?.completedRevision ?? 0,
						update.completedRevision,
					);
					const readRevision = Math.max(
						old?.readRevision ?? 0,
						update.readRevision,
					);
					if (
						!old ||
						old.completedRevision !== completedRevision ||
						old.readRevision !== readRevision
					) {
						next.set(key, { ...update, completedRevision, readRevision });
					}
					versions.set(key, version);
					changed = true;
				}
				return changed ? { client, states: next, versions } : current;
			});
		},
		[client],
	);
	const acknowledge = useCallback(
		(state: SessionReadState) => {
			if (!client || state.readRevision >= state.completedRevision) return;
			void client
				.markSessionRead(
					state.projectId,
					state.sessionPath,
					state.completedRevision,
				)
				.then((next) => {
					if (activeClientRef.current === client) applyStates([next]);
				})
				.catch((error) => {
					if (activeClientRef.current === client) reportError(error);
				});
		},
		[client, applyStates, reportError],
	);
	const handleReadEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			if (!client || activeClientRef.current !== client) return;
			switch (event.type) {
				case "session_turn_completed":
					if (
						document.visibilityState === "visible" &&
						document.hasFocus() &&
						selectedPathRef.current ===
							chatUiStateKey(event.projectId, event.sessionPath)
					) {
						const seen = seenCompletionsRef.current;
						seen.add(event.completionId);
						// Bound pending receipts if storage repeatedly fails.
						if (seen.size > 512) {
							const oldest = seen.values().next().value;
							if (oldest) seen.delete(oldest);
						}
					}
					break;
				case "session_read_state_changed": {
					const seen = event.completionId
						? seenCompletionsRef.current.delete(event.completionId)
						: false;
					applyStates([event.state]);
					// Acknowledge this exact turn even if selection/focus changed
					// while its completion was waiting for SQLite.
					if (seen) acknowledge(event.state);
					break;
				}
			}
		},
		[acknowledge, applyStates, client],
	);

	/* oxlint-disable react/exhaustive-effect-dependencies -- refreshKey is an explicit Host recovery generation that must reload the full read-state snapshot. */
	useEffect(() => {
		if (!client) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const refresh = async () => {
			const request = ++refreshRequestRef.current;
			const version = updateVersionRef.current;
			try {
				const next = await client.loadSessionReadStates();
				if (!disposed && request === refreshRequestRef.current)
					applyStates(next, version);
			} catch (error) {
				if (!disposed && request === refreshRequestRef.current)
					reportError(error);
			}
		};
		const initialize = async () => {
			try {
				if (subscribe) {
					const cleanup = await subscribe(handleReadEvent);
					if (disposed) {
						cleanup();
						return;
					}
					unlisten = cleanup;
				}
				await refresh();
			} catch (error) {
				if (!disposed) reportError(error);
			}
		};
		const handleVisibility = () => {
			const next =
				document.visibilityState === "visible" && document.hasFocus();
			setVisible(next);
			if (next) void refresh();
		};
		void initialize();
		document.addEventListener("visibilitychange", handleVisibility);
		window.addEventListener("focus", handleVisibility);
		window.addEventListener("blur", handleVisibility);
		return () => {
			disposed = true;
			unlisten?.();
			document.removeEventListener("visibilitychange", handleVisibility);
			window.removeEventListener("focus", handleVisibility);
			window.removeEventListener("blur", handleVisibility);
		};
	}, [
		client,
		refreshKey,
		subscribe,
		handleReadEvent,
		applyStates,
		reportError,
	]);

	const selectedState = selectedPathKey
		? states.get(selectedPathKey)
		: undefined;
	useEffect(() => {
		if (visible && selectedState) acknowledge(selectedState);
	}, [visible, selectedState, refreshKey, acknowledge]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const unread = useMemo(() => {
		const next = new Set<string>();
		for (const session of sessions) {
			const key = chatUiStateKey(session.projectId, session.id);
			if (key === selectedSessionKey) continue;
			const state = session.sessionPath
				? states.get(chatUiStateKey(session.projectId, session.sessionPath))
				: undefined;
			if (
				state
					? state.completedRevision > state.readRevision
					: localUnread.has(key)
			)
				next.add(key);
		}
		return next;
	}, [sessions, selectedSessionKey, states, localUnread]);
	return { unread, handleReadEvent };
}
