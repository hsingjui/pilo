import { useCallback, useEffect, useRef, useState } from "react";

import type { NextPromptModel, NextPromptSettings } from "@shared/next-prompt";
import type { PiloClient } from "@shared/api/pilo-client";
import {
	runtimeErrorMessage,
	type PiloRuntimeEvent,
} from "@/lib/api/pi-runtime";

export function useNextPromptSettings(
	client: PiloClient | null,
	connectionId: string,
	refreshKey = "",
) {
	const [state, setState] = useState<{
		client: PiloClient | null;
		connectionId: string;
		settings: NextPromptSettings | null;
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
		(settings: NextPromptSettings) => {
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
			const settings = await client.loadNextPromptSettings(connectionId);
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
	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Reset Host-owned settings when changing transport/Connection; refreshKey is an explicit recovery trigger, never a Pi launch. */
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
		async (enabled: boolean, model: NextPromptModel | null) => {
			if (!client || !connectionId || savingRef.current) return;
			savingRef.current = true;
			setState((current) => ({ ...current, saving: true, error: null }));
			try {
				accept(
					await client.saveNextPromptSettings(connectionId, enabled, model),
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
				event.type === "next_prompt_settings_changed" &&
				event.settings.connectionId === connectionId
			) {
				accept(event.settings);
			}
		},
		[accept, connectionId],
	);
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
