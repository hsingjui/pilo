import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChatRuntimeRecoveryState } from "@/components/chat/chat-runtime-types";
import type { PiloClientEventMessage } from "@/lib/pilo-client";
import {
	REMOTE_SEQUENCE_KEY,
	REMOTE_TOKEN_KEY,
	pairRemote,
} from "./remote-client";
import { WebPiloClient } from "./web-pilo-client";

type UseRemoteConnectionOptions = {
	pairingSecret: string | null;
	onSocketMessageRef: { current: (message: PiloClientEventMessage) => void };
	onReconnectProbeRef: { current: () => void };
};

export function useRemoteConnection({
	pairingSecret,
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
	const [pairing, setPairing] = useState(Boolean(pairingSecret));
	const [fatalError, setFatalError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [reconnectKey, setReconnectKey] = useState(0);
	const [resyncKey, setResyncKey] = useState(0);
	const [recoveryState, setRecoveryState] = useState<ChatRuntimeRecoveryState>({
		status: "idle",
		recoverable: true,
		messageKey: "",
	});
	const reconnectAttemptsRef = useRef(0);

	const handleExpiredAuth = useCallback(
		(error: unknown) => {
			if (error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED") {
				window.localStorage.removeItem(REMOTE_TOKEN_KEY);
				setToken(null);
				setFatalError(t("settings.remoteAuthorizationExpired"));
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
		setRecoveryState({
			status: "reconnecting",
			recoverable: true,
			messageKey: "chat.reconnecting",
		});
		reconnectAttemptsRef.current = 0;
		setReconnectKey((value) => value + 1);
	}, []);

	useEffect(() => {
		if (!pairingSecret) return;
		let cancelled = false;
		void pairRemote(pairingSecret)
			.then((result) => {
				if (cancelled) return;
				window.localStorage.setItem(REMOTE_TOKEN_KEY, result.token);
				window.history.replaceState({}, "", window.location.pathname);
				setToken(result.token);
				setFatalError(null);
			})
			.catch((error) => {
				if (!cancelled)
					setFatalError(String(error instanceof Error ? error.message : error));
			})
			.finally(() => {
				if (!cancelled) setPairing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [pairingSecret]);

	/* oxlint-disable react/exhaustive-effect-dependencies -- reconnectKey is an explicit retry generation used only to recreate the external WebSocket. */
	useEffect(() => {
		void reconnectKey;
		if (!client) return;
		let cancelled = false;
		let disconnect: (() => void) | undefined;
		let reconnectTimer: number | undefined;
		const stored = Number(
			window.localStorage.getItem(REMOTE_SEQUENCE_KEY) ?? "0",
		);
		void client
			.connectEvents({
				after: Number.isFinite(stored) && stored > 0 ? stored : undefined,
				onMessage: (message) => onSocketMessageRef.current(message),
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
					if (isConnected) reconnectAttemptsRef.current = 0;
					if (!isConnected && reconnectTimer === undefined) {
						// ponytail: the browser reports a rejected WebSocket handshake as an
						// opaque 1006 close, so the socket can never say "token died". Probe an
						// authenticated endpoint instead: a stale token then clears locally and
						// lands on the pairing screen via handleExpiredAuth. Replace with a
						// CloseFrame(4001) if this probe ever gets too chatty.
						onReconnectProbeRef.current();
						// ponytail: capped exponential backoff so a dead token cannot
						// hammer the Host every 1.5s forever.
						const delay = Math.min(
							1_500 * 2 ** Math.min(reconnectAttemptsRef.current, 4),
							30_000,
						);
						reconnectAttemptsRef.current += 1;
						reconnectTimer = window.setTimeout(
							() => setReconnectKey((value) => value + 1),
							delay,
						);
					}
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
		return () => {
			cancelled = true;
			if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
			disconnect?.();
		};
	}, [
		client,
		handleExpiredAuth,
		reconnectKey,
		onSocketMessageRef,
		onReconnectProbeRef,
	]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	return {
		token,
		client,
		pairing,
		fatalError,
		setFatalError,
		connected,
		recoveryState,
		reconnectNow,
		resyncKey,
		setResyncKey,
		handleExpiredAuth,
	};
}
