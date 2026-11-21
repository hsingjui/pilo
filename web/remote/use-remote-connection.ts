import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChatRuntimeRecoveryState } from "@/components/chat/chat-runtime-types";
import type { PiloClientEventMessage } from "@shared/api/pilo-client";
import {
	resolveRemoteConnectionState,
	type RemoteConnectionState,
} from "./remote-connection-state";
import { REMOTE_SEQUENCE_KEY, REMOTE_TOKEN_KEY } from "./remote-client";
import { WebPiloClient } from "./web-pilo-client";

const OFFLINE_RETRY_DELAY_MS = 30_000;

type UseRemoteConnectionOptions = {
	browserOnline: boolean;
	recoveryGeneration: number;
	onSocketMessageRef: { current: (message: PiloClientEventMessage) => void };
	onReconnectProbeRef: { current: () => void };
};

export function useRemoteConnection({
	browserOnline,
	recoveryGeneration,
	onSocketMessageRef,
	onReconnectProbeRef,
}: UseRemoteConnectionOptions) {
	const { t } = useTranslation();
	const [token, setToken] = useState(() =>
		window.localStorage.getItem(REMOTE_TOKEN_KEY),
	);
	const client = useMemo(
		() => (token ? new WebPiloClient(token) : null),
		[token],
	);
	const [fatalError, setFatalError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [validatedRecoveryGeneration, setValidatedRecoveryGeneration] =
		useState(0);
	const validatedRecoveryGenerationRef = useRef(0);
	const browserOnlineRef = useRef(browserOnline);
	const [reconnectKey, setReconnectKey] = useState(0);
	const [resyncKey, setResyncKey] = useState(0);
	const [snapshotRefreshKey, setSnapshotRefreshKey] = useState(0);
	const [recoveryState, setRecoveryState] = useState<ChatRuntimeRecoveryState>({
		status: "idle",
		recoverable: true,
		messageKey: "",
	});
	const reconnectAttemptsRef = useRef(0);
	const needsSnapshotRefreshRef = useRef(false);
	// Storage seeds a new page; reconnects use the cursor advanced by the transport.
	const [lastSequenceRef] = useState(() => {
		const stored = Number(
			window.localStorage.getItem(REMOTE_SEQUENCE_KEY) ?? "0",
		);
		return { current: Number.isFinite(stored) && stored > 0 ? stored : 0 };
	});

	const networkState: RemoteConnectionState = resolveRemoteConnectionState(
		browserOnline,
		connected && validatedRecoveryGeneration === recoveryGeneration,
	);

	useEffect(() => {
		browserOnlineRef.current = browserOnline;
	}, [browserOnline]);

	const handleExpiredAuth = useCallback(
		(error: unknown) => {
			if (error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED") {
				const currentToken = window.localStorage.getItem(REMOTE_TOKEN_KEY);
				setToken(currentToken);
				setFatalError(
					currentToken ? null : t("settings.remoteAuthorizationExpired"),
				);
				return true;
			}
			return false;
		},
		[t],
	);

	useEffect(() => {
		if (recoveryState.status !== "recovered") return;
		const timer = window.setTimeout(
			() =>
				setRecoveryState({
					status: "idle",
					recoverable: true,
					messageKey: "",
				}),
			2_500,
		);
		return () => window.clearTimeout(timer);
	}, [recoveryState.status]);

	const reconnectNow = useCallback(() => {
		setConnected(false);
		setRecoveryState({
			status: "reconnecting",
			recoverable: true,
			messageKey: "chat.reconnecting",
		});
		needsSnapshotRefreshRef.current = true;
		reconnectAttemptsRef.current = 0;
		setReconnectKey((value) => value + 1);
	}, []);

	/* oxlint-disable react/exhaustive-effect-dependencies -- reconnectKey and recoveryGeneration are explicit generations used only to recreate the external WebSocket. */
	useEffect(() => {
		void reconnectKey;
		void recoveryGeneration;
		if (!client) return;
		if (validatedRecoveryGenerationRef.current !== recoveryGeneration) {
			needsSnapshotRefreshRef.current = true;
		}
		let cancelled = false;
		let disconnect: (() => void) | undefined;
		let reconnectTimer: number | undefined;
		void client
			.connectEvents({
				after: lastSequenceRef.current || undefined,
				onMessage: (message) => {
					if (!cancelled) onSocketMessageRef.current(message);
				},
				onStatus: (isConnected) => {
					if (cancelled) return;
					setConnected(isConnected);
					setRecoveryState((current) => {
						if (!isConnected) {
							return {
								status: "reconnecting",
								recoverable: true,
								messageKey: "chat.reconnecting",
							};
						}
						if (current.status === "reconnecting") {
							return {
								status: "recovered",
								recoverable: true,
								messageKey: "chat.reconnected",
							};
						}
						return current;
					});
					if (isConnected) {
						reconnectAttemptsRef.current = 0;
						validatedRecoveryGenerationRef.current = recoveryGeneration;
						setValidatedRecoveryGeneration(recoveryGeneration);
						if (needsSnapshotRefreshRef.current) {
							needsSnapshotRefreshRef.current = false;
							setSnapshotRefreshKey((value) => value + 1);
						}
						return;
					}

					needsSnapshotRefreshRef.current = true;
					if (reconnectTimer !== undefined) return;

					const online = browserOnlineRef.current;
					if (online) {
						// Browser WebSocket handshake failures surface as opaque 1006 closes,
						// so an authenticated HTTP probe still owns stale-token detection.
						onReconnectProbeRef.current();
					}
					const delay = online
						? Math.min(
								1_500 * 2 ** Math.min(reconnectAttemptsRef.current, 4),
								OFFLINE_RETRY_DELAY_MS,
							)
						: OFFLINE_RETRY_DELAY_MS;
					reconnectAttemptsRef.current += 1;
					reconnectTimer = window.setTimeout(
						() => setReconnectKey((value) => value + 1),
						delay,
					);
				},
			})
			.then((stop) => {
				if (cancelled) stop();
				else disconnect = stop;
			})
			.catch((error) => {
				if (!cancelled && !handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			});
		// Backoff timers are throttled or frozen in background tabs; returning to
		// the foreground reconnects immediately instead of waiting them out.
		const reconnectOnForeground = () => {
			if (
				cancelled ||
				document.visibilityState !== "visible" ||
				reconnectTimer === undefined ||
				!browserOnlineRef.current
			)
				return;
			// This socket generation is being replaced; ignore its late close events.
			cancelled = true;
			reconnectAttemptsRef.current = 0;
			setReconnectKey((value) => value + 1);
		};
		document.addEventListener("visibilitychange", reconnectOnForeground);
		return () => {
			cancelled = true;
			document.removeEventListener("visibilitychange", reconnectOnForeground);
			if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
			disconnect?.();
		};
	}, [
		client,
		handleExpiredAuth,
		lastSequenceRef,
		reconnectKey,
		recoveryGeneration,
		onSocketMessageRef,
		onReconnectProbeRef,
	]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	return {
		token,
		client,
		fatalError,
		setFatalError,
		networkState,
		recoveryState,
		reconnectNow,
		lastSequenceRef,
		resyncKey,
		setResyncKey,
		snapshotRefreshKey,
		handleExpiredAuth,
	};
}
