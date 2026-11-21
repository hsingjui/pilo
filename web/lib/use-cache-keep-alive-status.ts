import { useCallback, useEffect, useRef, useState } from "react";

import type { CacheKeepAliveStatus } from "@shared/cache-keep-alive";
import type {
	PiloClient,
	PiloClientEventMessage,
} from "@shared/api/pilo-client";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";

export function useCacheKeepAliveStatus({
	client,
	sessionKey,
	active = true,
	refreshKey = "",
}: {
	client: PiloClient | null;
	sessionKey: string | null;
	active?: boolean;
	refreshKey?: string;
}) {
	const [state, setState] = useState<{
		client: PiloClient;
		sessionKey: string;
		refreshKey: string;
		status: CacheKeepAliveStatus | null;
	} | null>(null);
	const request = useRef({ revision: 0 });
	const refresh = useCallback(async () => {
		if (!client || !sessionKey || !active) return;
		const revision = ++request.current.revision;
		try {
			const runtime = await client.chatState(sessionKey);
			if (revision === request.current.revision)
				setState({
					client,
					sessionKey,
					refreshKey,
					status: runtime?.cacheKeepAlive ?? null,
				});
		} catch {
			if (revision === request.current.revision) setState(null);
		}
	}, [client, sessionKey, active, refreshKey]);
	const handleEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			if (event.sessionKey !== sessionKey) return;
			if (
				event.type === "process_state" ||
				(event.type === "extension_ui_request" &&
					event.method === "setWidget" &&
					event.widgetKey === "pilo.cache-keep-alive.v1")
			) {
				// Read current Host state, not replayed Widget JSON or a stale generation.
				void refresh();
			}
		},
		[refresh, sessionKey],
	);
	const handleMessage = useCallback(
		(message: PiloClientEventMessage) => {
			if (message.type === "events")
				for (const event of message.events) handleEvent(event);
			else void refresh();
		},
		[handleEvent, refresh],
	);
	useEffect(() => {
		const gate = request.current;
		let disposed = false;
		queueMicrotask(() => {
			if (!disposed) void refresh();
		});
		const foreground = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		window.addEventListener("focus", foreground);
		document.addEventListener("visibilitychange", foreground);
		return () => {
			disposed = true;
			gate.revision++;
			window.removeEventListener("focus", foreground);
			document.removeEventListener("visibilitychange", foreground);
		};
	}, [refresh]);
	return {
		status:
			active &&
			state?.client === client &&
			state?.sessionKey === sessionKey &&
			state.refreshKey === refreshKey
				? state.status
				: null,
		handleMessage,
	};
}
