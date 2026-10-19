import { useCallback, useEffect, useRef, useState } from "react";

import type { PiloClient } from "@/lib/api/pilo-client";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import { listenRuntimeEvents, runtimeErrorMessage } from "@/lib/api/pi-runtime";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@/lib/prompt-enhancement";

/**
 * Host-owned prompt enhancement settings for one Connection.
 *
 * Desktop reads them through the Tauri command and the Remote WebUI through the
 * authenticated HTTP route, so both clients show the same switch and model.
 * The listener is internal because every composer surface needs it: a second
 * window or the WebUI must not leave a stale switch behind.
 */
export function usePromptEnhancementSettings(
	client: PiloClient | null,
	connectionId: string,
	refreshKey = "",
) {
	const [state, setState] = useState<{
		client: PiloClient | null;
		connectionId: string;
		settings: PromptEnhancementSettings | null;
		loading: boolean;
		saving: boolean;
		error: string | null;
	}>({
		client,
		connectionId,
		settings: null,
		loading: true,
		saving: false,
		error: null,
	});
	const requestRef = useRef(0);
	const savingRef = useRef(false);
	const accept = useCallback(
		(settings: PromptEnhancementSettings) => {
			if (settings.connectionId !== connectionId) return;
			setState((current) =>
				current.client !== client ||
				current.connectionId !== connectionId ||
				(current.settings?.updatedAtMs ?? -1) > settings.updatedAtMs
					? current
					: { ...current, settings, loading: false, error: null },
			);
		},
		[client, connectionId],
	);
	const refresh = useCallback(async () => {
		if (!client || !connectionId) return;
		const request = ++requestRef.current;
		try {
			const settings = await client.loadPromptEnhancementSettings(connectionId);
			if (request === requestRef.current) accept(settings);
		} catch (error) {
			if (request !== requestRef.current) return;
			setState((current) =>
				current.client === client &&
				current.connectionId === connectionId &&
				!current.settings
					? { ...current, loading: false, error: runtimeErrorMessage(error) }
					: current,
			);
		}
	}, [accept, client, connectionId]);
	const invalidateRefresh = useCallback(() => {
		requestRef.current++;
	}, []);
	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Reset Host-owned settings when changing transport/Connection; refreshKey is an explicit recovery trigger. */
	useEffect(() => {
		void refreshKey;
		setState((current) =>
			current.client === client && current.connectionId === connectionId
				? current
				: {
						client,
						connectionId,
						settings: null,
						loading: true,
						saving: false,
						error: null,
					},
		);
		void refresh();
		const foreground = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		window.addEventListener("focus", foreground);
		document.addEventListener("visibilitychange", foreground);
		return () => {
			invalidateRefresh();
			window.removeEventListener("focus", foreground);
			document.removeEventListener("visibilitychange", foreground);
		};
	}, [client, connectionId, refresh, refreshKey, invalidateRefresh]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */
	const save = useCallback(
		async (enabled: boolean, model: PromptEnhancementModel | null) => {
			if (!client || !connectionId || savingRef.current) return;
			savingRef.current = true;
			setState((current) => ({ ...current, saving: true, error: null }));
			try {
				accept(
					await client.savePromptEnhancementSettings(
						connectionId,
						enabled,
						model,
					),
				);
			} catch (error) {
				setState((current) =>
					current.client === client && current.connectionId === connectionId
						? { ...current, error: runtimeErrorMessage(error) }
						: current,
				);
			} finally {
				savingRef.current = false;
				setState((current) => ({ ...current, saving: false }));
			}
		},
		[accept, client, connectionId],
	);
	const handleEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			if (
				event.type === "prompt_enhancement_settings_changed" &&
				event.settings.connectionId === connectionId
			) {
				accept(event.settings);
			}
		},
		[accept, connectionId],
	);
	useEffect(() => {
		let disposed = false;
		let stop: (() => void) | undefined;
		void listenRuntimeEvents(handleEvent)
			.then((unlisten) => {
				if (disposed) unlisten();
				else stop = unlisten;
			})
			// The Remote WebUI receives Host events over its socket, not this channel.
			.catch(() => undefined);
		return () => {
			disposed = true;
			stop?.();
		};
	}, [handleEvent]);
	const current =
		state.client === client && state.connectionId === connectionId;
	return {
		settings: current ? state.settings : null,
		loading: !current || state.loading,
		saving: state.saving,
		error: current ? state.error : null,
		refresh,
		save,
		handleEvent,
	};
}
