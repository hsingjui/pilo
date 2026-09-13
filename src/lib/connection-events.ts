export const CONNECTIONS_CHANGED_EVENT = "pilo:connections-changed";

export function notifyConnectionsChanged(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
}
