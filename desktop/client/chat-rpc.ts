import type { NshPiloClient } from "./nsh-pilo-client";

export type PiCommandClient = Pick<
	NshPiloClient,
	"sendChatCommand" | "connectEvents"
>;

export const PI_RPC_TIMEOUT_MS = 5000;

let rpcSequence = 0;

/** An `rpc_message` response, as Pi replies it. */
export type PiRpcReply<T> = {
	data?: T;
	success?: boolean;
	error?: string;
};

/**
 * A request/response Pi RPC over the command channel: the command is sent
 * with a unique `id`, and its reply arrives as an `rpc_message` session
 * event carrying the same `id`. Resolves the reply — a success reply can
 * carry no `data` — or `null` when the reply never comes (timeout or a
 * dropped event stream), and rejects on a `success: false` reply or a
 * send failure.
 */
export function requestPiRpcReply<T>(
	client: PiCommandClient,
	sessionKey: string,
	command: Record<string, unknown>,
	timeoutMs = PI_RPC_TIMEOUT_MS,
): Promise<PiRpcReply<T> | null> {
	const id = `nsh-rpc-${++rpcSequence}`;
	return new Promise<PiRpcReply<T> | null>((resolve, reject) => {
		let settled = false;
		let disconnect: (() => void) | null = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			disconnect?.();
			disconnect = null;
		};
		const timer = setTimeout(() => {
			finish();
			resolve(null);
		}, timeoutMs);
		client
			.connectEvents({
				onMessage: (message) => {
					if (settled || message.type !== "events") return;
					for (const event of message.events) {
						if (event.type !== "rpc_message" || event.sessionKey !== sessionKey)
							continue;
						const reply = event.message;
						if (
							typeof reply !== "object" ||
							reply === null ||
							(reply as Record<string, unknown>).type !== "response" ||
							(reply as Record<string, unknown>).id !== id
						)
							continue;
						const data = reply as PiRpcReply<T>;
						finish();
						if (data.success === false)
							reject(new Error(data.error ?? "Pi command failed"));
						else resolve(data);
						return;
					}
				},
				onStatus: (connected) => {
					if (!connected && !settled) {
						finish();
						resolve(null);
					}
				},
			})
			.then((disposer) => {
				if (settled) {
					disposer();
					return;
				}
				disconnect = disposer;
				return client.sendChatCommand(sessionKey, { ...command, id });
			})
			.catch((error: unknown) => {
				finish();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
	});
}

/**
 * {@link requestPiRpcReply} for callers that only want the reply's `data`:
 * `null` when the reply never came or it carried none.
 */
export function requestPiRpc<T>(
	client: PiCommandClient,
	sessionKey: string,
	command: Record<string, unknown>,
	timeoutMs = PI_RPC_TIMEOUT_MS,
): Promise<T | null> {
	return requestPiRpcReply<T>(client, sessionKey, command, timeoutMs).then(
		(reply) => reply?.data ?? null,
	);
}
