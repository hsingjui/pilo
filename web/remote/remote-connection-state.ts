export type RemoteConnectionState = "connected" | "offline" | "reconnecting";

export function resolveRemoteConnectionState(
	browserOnline: boolean,
	socketConnected: boolean,
): RemoteConnectionState {
	if (socketConnected) return "connected";
	return browserOnline ? "reconnecting" : "offline";
}

export function remoteConnectionLabelKey(
	state: RemoteConnectionState,
):
	| "settings.remoteConnected"
	| "settings.remoteOffline"
	| "settings.remoteReconnecting" {
	switch (state) {
		case "connected":
			return "settings.remoteConnected";
		case "offline":
			return "settings.remoteOffline";
		case "reconnecting":
			return "settings.remoteReconnecting";
	}
}
