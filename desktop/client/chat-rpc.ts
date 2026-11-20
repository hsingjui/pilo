import type { NshPiloClient } from "./nsh-pilo-client";

export type PiCommandClient = Pick<
	NshPiloClient,
	"sendChatCommand" | "connectEvents"
>;

export const PI_RPC_TIMEOUT_MS = 5000;

let rpcSequence = 0;

/**
 * A request/response Pi RPC over the command channel: the command is sent
 * with a unique `id`, and its reply arrives as an `rpc_message` session
 * event carrying the same `id`. Resolves `null` when the reply never comes
 * (timeout or a dropped event stream) and rejects on a `success: false`
 * reply or a send failure.
 */
export function requestPiRpc<T>(
	client: PiCommandClient,
	sessionKey: string,
	command: Record<string, unknown>,
	timeoutMs = PI_RPC_TIMEOUT_MS,
): Promise<T | null> {
	const id = `nsh-rpc-${++rpcSequence}`;
	return new Promise<T | null>((resolve, reject) => {
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
						const data = reply as {
							data?: T;
							success?: boolean;
							error?: string;
						};
						finish();
						if (data.success === false)
							reject(new Error(data.error ?? "Pi command failed"));
						else resolve(data.data ?? null);
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
