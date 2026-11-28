import { cleanup, effect, lifecycle, untracked } from "nsh";

import type { HostClient } from "@shared/api/host-client";
import type { HostApiMethodName } from "@shared/api/host-methods";
import {
	HttpTransport,
	type CursorStore,
	type HostTransportConnectionState,
	type NetworkSignals,
} from "@shared/api/host-transport";
import type { RemoteScopes } from "@shared/api/remote-types";
import { hostStorageKey, LOCAL_HOST_ID } from "@shared/host-id";
import {
	browserGlobal,
	clearRemoteDeviceToken,
	isBrowserOnline,
	readBrowserLocalStorage,
	resolvePageOrigin,
	writeBrowserLocalStorage,
} from "./web-remote-browser";

export const REMOTE_SEQUENCE_KEY = "pilo.nsh.remote.sequence.v1";

export type WebRemoteConnectionState = HostTransportConnectionState;
export type WebRemoteRecoveryState = "idle" | "reconnecting" | "recovered";

export function canUseWebWorkspace(
	scopes: RemoteScopes | undefined,
	client: Pick<HostClient, "hasMethod">,
	...methods: HostApiMethodName[]
) {
	return (
		scopes === "chat,workspace" &&
		methods.every((method) => client.hasMethod(method))
	);
}

export const webCursorStore: CursorStore = {
	getCursor(hostId) {
		const key = hostStorageKey(hostId, REMOTE_SEQUENCE_KEY);
		const legacy = hostId === LOCAL_HOST_ID ? [REMOTE_SEQUENCE_KEY] : [];
		const sequence = Number(readBrowserLocalStorage(key, ...legacy));
		return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
	},
	setCursor(hostId, sequence) {
		writeBrowserLocalStorage(
			hostStorageKey(hostId, REMOTE_SEQUENCE_KEY),
			String(sequence),
		);
	},
};

function browserNetworkSignals(): NetworkSignals {
	const win = browserGlobal();
	const subscribe = (type: string, listener: () => void) => {
		win.addEventListener?.(type, listener);
		return () => win.removeEventListener?.(type, listener);
	};
	const foreground = new Set<() => void>();
	const background = new Set<() => void>();
	const add = (listeners: Set<() => void>, listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	let previous = untracked(lifecycle);
	effect(() => {
		const current = lifecycle();
		if (current === previous) return;
		previous = current;
		const listeners =
			current === "active"
				? foreground
				: current === "background"
					? background
					: [];
		untracked(() => {
			for (const listener of listeners) listener();
		});
	});
	return {
		isOnline: isBrowserOnline,
		onOnline: (listener) => subscribe("online", listener),
		onOffline: (listener) => subscribe("offline", listener),
		onForeground: (listener) => add(foreground, listener),
		onBackground: (listener) => {
			const remove = add(background, listener);
			const removePageHide = subscribe("pagehide", listener);
			return () => {
				remove();
				removePageHide();
			};
		},
	};
}

export function createWebHostTransport(
	token: string,
	onUnauthorized: () => void,
) {
	const transport = new HttpTransport({
		origin: resolvePageOrigin(),
		tokens: { getToken: () => token },
		cursors: webCursorStore,
		network: browserNetworkSignals(),
		foregroundProbeMinHiddenMs: 1_500,
		probeTimeoutMs: 5_000,
		onUnauthorized: () => {
			void clearRemoteDeviceToken(token);
			onUnauthorized();
		},
	});
	cleanup(() => transport.dispose());
	return transport;
}
