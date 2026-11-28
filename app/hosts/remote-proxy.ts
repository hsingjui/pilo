import { RemoteProxy, RemoteProxyRequest, RemoteProxySocket } from "app/native";

import type { FetchLike, WebSocketLike } from "@shared/api/host-transport";
import type { RemoteHostProxyTransport } from "./host-registry";

class ProxiedSocket implements WebSocketLike {
	readyState = 0;
	private readonly native: RemoteProxySocket;
	private readonly listeners = {
		message: new Set<(event: { data: unknown }) => void>(),
		close: new Set<(event: { data: unknown }) => void>(),
		error: new Set<(event: { data: unknown }) => void>(),
	};

	constructor(proxyUrl: string | null, url: string, protocols: string[]) {
		this.native = new RemoteProxySocket(proxyUrl, url, protocols);
		void this.listen();
	}

	addEventListener(
		type: keyof ProxiedSocket["listeners"],
		listener: (event: { data: unknown }) => void,
	) {
		this.listeners[type].add(listener);
	}

	removeEventListener(
		type: keyof ProxiedSocket["listeners"],
		listener: (event: { data: unknown }) => void,
	) {
		this.listeners[type].delete(listener);
	}

	send(data: string) {
		this.native.send(data);
	}

	close() {
		this.readyState = 3;
		this.native.close();
	}

	private async listen() {
		try {
			while (this.readyState < 2) {
				// oxlint-disable-next-line no-await-in-loop -- Consume the ordered native event stream.
				const event = await this.native.nextEvent();
				if (!event || this.readyState >= 2) break;
				if (event.text === null) this.readyState = 1;
				else
					for (const listener of this.listeners.message)
						listener({ data: event.text });
			}
		} catch {
			if (this.readyState < 2)
				for (const listener of this.listeners.error)
					listener({ data: undefined });
		} finally {
			if (this.readyState < 2) {
				this.close();
				for (const listener of this.listeners.close)
					listener({ data: undefined });
			}
		}
	}
}

function proxyFetch(proxyUrl: string | null): FetchLike {
	return async (url, init) => {
		const signal = init?.signal;
		if (signal?.aborted) throw new Error("Request aborted");
		const body =
			typeof init?.body === "string"
				? new TextEncoder().encode(init.body)
				: init?.body;
		const request = new RemoteProxyRequest(
			proxyUrl,
			url,
			init?.method ?? "GET",
			init?.headers ?? {},
			body ?? null,
		);
		const abort = () => request.abort();
		signal?.addEventListener("abort", abort);
		try {
			const { status, body } = await request.response();
			const text = () => new TextDecoder().decode(body);
			return {
				ok: status >= 200 && status < 300,
				status,
				text: async () => text(),
				json: async () => JSON.parse(text()),
				arrayBuffer: async () => new Uint8Array(body).buffer,
			};
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	};
}

export const desktopRemoteProxy: RemoteHostProxyTransport = {
	savedUrl: (hostId) => RemoteProxy.savedUrl(hostId),
	saveUrl: (hostId, url) => RemoteProxy.saveUrl(hostId, url),
	deleteUrl: (hostId) => RemoteProxy.deleteUrl(hostId),
	connect: (proxy) => {
		const proxyUrl = proxy.mode === "custom" ? proxy.url : null;
		return {
			fetch: proxyFetch(proxyUrl),
			createWebSocket: (url, protocols = []) =>
				new ProxiedSocket(proxyUrl, url, protocols),
		};
	},
};
